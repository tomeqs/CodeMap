using System.IO.Pipelines;
using System.Runtime.InteropServices;
using System.Text.Json;
using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Mcp;
using CodeMap.Mcp.Rendering;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace CodeMap.Tests;

/// <summary>A test that needs a Chromium-based browser (skipped without one, or with CODEMAP_SKIP_BROWSER=1).</summary>
public sealed class BrowserFactAttribute : FactAttribute
{
    public BrowserFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("CODEMAP_SKIP_BROWSER") == "1") Skip = "CODEMAP_SKIP_BROWSER is set.";
        else if (BrowserLocator.Find() == null) Skip = "No Chrome, Edge or Chromium is installed.";
    }
}

/// <summary>render_map: finding a browser, talking to it, and a picture of samples/Shop.</summary>
public class RenderTests
{
    [Fact]
    public void Browsers_are_looked_for_where_each_system_installs_them_after_the_one_given()
    {
        var env = new Dictionary<string, string?>
        {
            ["CODEMAP_BROWSER"] = "/env/chrome",
            ["PATH"] = "/usr/local/bin:/usr/bin",
            ["ProgramFiles"] = @"C:\Program Files",
            ["ProgramFiles(x86)"] = @"C:\Program Files (x86)",
            ["LOCALAPPDATA"] = @"C:\Users\me\AppData\Local",
        };
        string? Env(string name) => env.GetValueOrDefault(name);

        var linux = BrowserLocator.Candidates("/given/chrome", Env, OSPlatform.Linux, "/home/me").ToList();
        Assert.Equal(new[] { "/given/chrome", "/env/chrome", Path.Combine("/usr/local/bin", "google-chrome") }, linux.Take(3));
        Assert.Contains(Path.Combine("/usr/bin", "chromium"), linux);
        Assert.Contains("/opt/pw-browsers/chromium", linux);

        var windows = BrowserLocator.Candidates(null, Env, OSPlatform.Windows, @"C:\Users\me").ToList();
        Assert.Equal("/env/chrome", windows[0]);
        Assert.Contains(windows, c => c.EndsWith("msedge.exe", StringComparison.Ordinal));
        Assert.True(windows.FindIndex(c => c.EndsWith("msedge.exe", StringComparison.Ordinal)) < windows.FindIndex(c => c.EndsWith("chrome.exe", StringComparison.Ordinal)));

        var mac = BrowserLocator.Candidates(null, _ => null, OSPlatform.OSX, "/Users/me").ToList();
        Assert.Equal(Path.Combine("/Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), mac[0]);
    }

    [Fact]
    public void The_devtools_port_file_gives_the_port_and_the_browser_path()
    {
        Assert.Equal((53412, "/devtools/browser/abc-123"), ChromiumProcess.Parse("53412\n/devtools/browser/abc-123\n"));
        Assert.Null(ChromiumProcess.Parse("53412\n"));
        Assert.Null(ChromiumProcess.Parse("port\n/devtools/browser/x"));
        Assert.Null(ChromiumProcess.Parse(""));
    }

    [Fact]
    public async Task The_page_host_serves_only_loopback_requests_with_its_token()
    {
        await using var host = await ViewerHost.StartAsync(CancellationToken.None);
        var url = new Uri(host.Publish("a.html", "<html>map</html>"));
        var token = url.Segments[2].TrimEnd('/');

        Assert.StartsWith("http://127.0.0.1:", host.Origin);
        Assert.True(host.Allowed(url.Authority, token));
        Assert.False(host.Allowed("evil.example:80", token));
        Assert.False(host.Allowed(url.Authority, "guess"));

        using var http = new HttpClient();
        Assert.Equal("<html>map</html>", await http.GetStringAsync(url));
        var forged = new HttpRequestMessage(HttpMethod.Get, url);
        forged.Headers.Host = "evil.example";
        Assert.Equal(System.Net.HttpStatusCode.Forbidden, (await http.SendAsync(forged)).StatusCode);
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await http.GetAsync(new Uri(url, "b.html"))).StatusCode);
    }

    [BrowserFact]
    public async Task A_picture_of_the_map_comes_with_what_it_shows()
    {
        var viewer = Path.Combine(GoldenTests.RepoRoot(), "src", "CodeMap.Cli", "Assets", "viewer.html");
        var options = new CodeMapMcpOptions
        {
            Analyzer = new AnalyzerOptions { Git = false },
            Watch = false,
            Registry = () => LanguageRegistry.BuiltIn,
            ViewerHtml = () => File.ReadAllText(viewer),
        };
        using var session = new CodeMapSession(options);
        var toServer = new Pipe();
        var toClient = new Pipe();
        await using var server = McpServer.Create(new StreamServerTransport(toServer.Reader.AsStream(), toClient.Writer.AsStream(), "codemap"), CodeMapMcpServer.CreateOptions(session));
        using var stop = new CancellationTokenSource();
        var running = server.RunAsync(stop.Token);
        await using var client = await McpClient.CreateAsync(new StreamClientTransport(toServer.Writer.AsStream(), toClient.Reader.AsStream()));

        await client.CallToolAsync("analyze", new Dictionary<string, object?> { ["path"] = Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln"), ["waitSeconds"] = 120 });
        foreach (var (args, units, hud) in new[]
                 {
                     (new Dictionary<string, object?> { ["view"] = "galaxy", ["level"] = "type", ["width"] = 800, ["height"] = 600 }, 48, "48 types"),
                     (new Dictionary<string, object?> { ["cycle"] = "Shop.Application.Pricing", ["width"] = 800, ["height"] = 600 }, 16, "Cycle between 2 namespaces"),
                 })
        {
            var result = await client.CallToolAsync("render_map", args);
            Assert.True(result.IsError != true, string.Concat(result.Content.OfType<TextContentBlock>().Select(t => t.Text)));
            var image = Assert.Single(result.Content.OfType<ImageContentBlock>());
            Assert.Equal("image/png", image.MimeType);
            Assert.Equal(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G' }, image.DecodedData.ToArray().Take(4));
            Assert.True(image.DecodedData.Length > 20_000);

            var caption = JsonDocument.Parse(result.Content.OfType<TextContentBlock>().Single().Text).RootElement;
            var shows = caption.GetProperty("shows");
            Assert.Equal(units, shows.GetProperty("units").GetInt32());
            Assert.Contains(shows.GetProperty("hud").EnumerateArray(), l => l.GetString()!.Contains(hud));
            Assert.Equal("webgl", shows.GetProperty("renderer").GetString());
        }

        stop.Cancel();
        try { await running; }
        catch (OperationCanceledException) { }
    }
}
