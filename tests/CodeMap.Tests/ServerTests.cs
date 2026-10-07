using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CodeMap.Export;
using CodeMap.Server;

namespace CodeMap.Tests;

public sealed class ServerTests : IAsyncLifetime
{
    private readonly TestWorkspace _ws = new TestWorkspace()
        .Project("App")
        .File("App/A.cs", "namespace App; public class A { public B Make() => new(); }")
        .File("App/B.cs", "namespace App; public class B { }")
        .File("App/bin/Debug/ignored.txt", "build output");

    private readonly string _home = Path.Combine(Path.GetTempPath(), "codemap-home-" + Guid.NewGuid().ToString("N"));
    private UiServer _server = null!;
    private HttpClient _client = null!;

    public async Task InitializeAsync()
    {
        _server = await UiServer.StartAsync(new UiServerOptions
        {
            ViewerHtml = "<html><head><title>CodeMap</title></head><body>" + HtmlExporter.Placeholder + "</body></html>",
            Port = 0,
            Home = _home,
            StartDirectory = _ws.Root,
        });
        _client = new HttpClient { BaseAddress = new Uri(_server.Url) };
        _client.DefaultRequestHeaders.Add(UiServer.TokenHeader, _server.Token);
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _server.DisposeAsync();
        _ws.Dispose();
        try { Directory.Delete(_home, recursive: true); }
        catch { /* best effort */ }
    }

    [Fact]
    public async Task Page_embeds_the_session_token()
    {
        using var anonymous = new HttpClient { BaseAddress = new Uri(_server.Url) };
        var html = await anonymous.GetStringAsync("/");

        Assert.Contains("id=\"codemap-server\"", html);
        Assert.Contains(_server.Token, html);
        Assert.Contains(HtmlExporter.Placeholder, html);
    }

    [Fact]
    public async Task Api_requires_the_token_and_a_local_host_header()
    {
        using var anonymous = new HttpClient { BaseAddress = new Uri(_server.Url) };
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/recent")).StatusCode);

        anonymous.DefaultRequestHeaders.Add(UiServer.TokenHeader, "wrong");
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/recent")).StatusCode);

        using var rebinding = new HttpRequestMessage(HttpMethod.Get, "/api/recent");
        rebinding.Headers.Host = "attacker.example";
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.SendAsync(rebinding)).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync("/api/recent")).StatusCode);
    }

    [Fact]
    public async Task Browse_lists_projects_and_skips_build_output()
    {
        var root = await _client.GetFromJsonAsync<JsonElement>("/api/browse");
        Assert.Equal(_ws.Root, root.GetProperty("path").GetString());
        Assert.Contains(root.GetProperty("entries").EnumerateArray(), e => e.GetProperty("name").GetString() == "App" && e.GetProperty("hasCode").GetBoolean());

        var app = await _client.GetFromJsonAsync<JsonElement>("/api/browse?path=" + Uri.EscapeDataString(Path.Combine(_ws.Root, "App")));
        var names = app.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("name").GetString()).ToList();
        Assert.Equal("App.csproj", names[0]);
        Assert.DoesNotContain("bin", names);

        var missing = await _client.GetAsync("/api/browse?path=" + Uri.EscapeDataString(Path.Combine(_ws.Root, "nope")));
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
    }

    [Fact]
    public async Task Analyze_runs_a_job_caches_the_graph_and_remembers_the_project()
    {
        var start = await _client.PostAsJsonAsync("/api/analyze", new { path = _ws.Root, settings = new { git = false } });
        start.EnsureSuccessStatusCode();
        var jobId = (await start.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("jobId").GetString()!;

        var job = await WaitForJob(jobId);
        Assert.Equal("done", job.GetProperty("status").GetString());

        var graph = await _client.GetStringAsync($"/api/jobs/{jobId}/graph");
        Assert.Contains("T:App.A", graph);

        var recent = await _client.GetFromJsonAsync<JsonElement>("/api/recent");
        var entry = Assert.Single(recent.EnumerateArray());
        Assert.Equal(_ws.Root, entry.GetProperty("path").GetString());
        var cached = await _client.GetStringAsync("/api/cache/" + entry.GetProperty("key").GetString());
        Assert.Contains("T:App.B", cached);

        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync("/api/recent?path=" + Uri.EscapeDataString(_ws.Root))).StatusCode);
        Assert.Empty((await _client.GetFromJsonAsync<JsonElement>("/api/recent")).EnumerateArray());
    }

    [Fact]
    public async Task Rejects_bad_requests()
    {
        var clone = await _client.PostAsJsonAsync("/api/clone", new { url = "--upload-pack=touch /tmp/x" });
        Assert.Equal(HttpStatusCode.BadRequest, clone.StatusCode);

        var analyze = await _client.PostAsJsonAsync("/api/analyze", new { path = Path.Combine(_ws.Root, "missing.sln") });
        Assert.Equal(HttpStatusCode.BadRequest, analyze.StatusCode);

        var cache = await _client.GetAsync("/api/cache/..%2F..%2Fetc");
        Assert.NotEqual(HttpStatusCode.OK, cache.StatusCode);
    }

    [Fact]
    public async Task Live_mode_reanalyzes_when_a_source_file_changes()
    {
        var start = await _client.PostAsJsonAsync("/api/analyze", new { path = _ws.Root, settings = new { git = false, watch = true } });
        var first = (await start.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("jobId").GetString()!;
        await WaitForJob(first);
        Assert.NotNull(_server.Jobs.WatchedPath);

        _ws.File("App/C.cs", "namespace App; public class C { public A? Owner { get; set; } }");

        var deadline = DateTime.UtcNow.AddSeconds(60);
        string? graph = null;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(300);
            if (_server.Jobs.Current is { Live: true, Status: "done" } live && live.Id != first)
            {
                graph = await _client.GetStringAsync($"/api/jobs/{live.Id}/graph");
                if (graph.Contains("T:App.C")) break;
            }
        }

        Assert.Contains("T:App.C", graph);
        (await _client.PostAsJsonAsync("/api/watch", new { enabled = false })).EnsureSuccessStatusCode();
        Assert.Null(_server.Jobs.WatchedPath);
    }

    [Theory]
    [InlineData("https://github.com/dotnet/eShop.git", true, "dotnet-eShop")]
    [InlineData("git@github.com:owner/repo.git", true, "owner-repo")]
    [InlineData("ssh://git@host/team/project", true, "team-project")]
    [InlineData("-c core.sshCommand=evil", false, null)]
    [InlineData("file:///etc", false, null)]
    [InlineData("", false, null)]
    public void Validates_git_urls(string url, bool valid, string? folder)
    {
        Assert.Equal(valid, GitCloner.IsValidUrl(url));
        if (folder != null) Assert.Equal(folder, GitCloner.FolderName(url));
    }

    [Theory]
    [InlineData("/repo/src/A.cs", true)]
    [InlineData("/repo/src/App.csproj", true)]
    [InlineData("/repo/Directory.Build.props", true)]
    [InlineData("/repo/src/obj/Debug/A.g.cs", false)]
    [InlineData("/repo/.git/index", false)]
    [InlineData("/repo/readme.md", false)]
    public void Live_mode_only_reacts_to_code_changes(string path, bool relevant) =>
        Assert.Equal(relevant, JobManager.IsRelevant(path));

    private async Task<JsonElement> WaitForJob(string jobId)
    {
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (true)
        {
            var job = await _client.GetFromJsonAsync<JsonElement>($"/api/jobs/{jobId}");
            if (job.GetProperty("status").GetString() != "running") return job;
            if (DateTime.UtcNow > deadline) throw new TimeoutException("Job did not finish.");
            await Task.Delay(200);
        }
    }
}
