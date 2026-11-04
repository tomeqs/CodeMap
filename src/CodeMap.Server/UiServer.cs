using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using CodeMap.Export;
using CodeMap.Languages;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CodeMap.Server;

/// <summary>
/// Local web UI: serves the 3D viewer plus a small JSON API to browse folders, analyze or clone
/// projects, reopen recent ones and stream progress. Listens on 127.0.0.1 only; every API call must
/// carry the per-session token that is embedded in the served page, and the Host header must be
/// local, so other web sites cannot drive it (CSRF / DNS rebinding).
/// </summary>
public sealed class UiServer : IAsyncDisposable
{
    public const string TokenHeader = "X-CodeMap-Token";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly WebApplication _app;
    private readonly JobManager _jobs;

    private UiServer(WebApplication app, JobManager jobs, string token, int port)
    {
        _app = app;
        _jobs = jobs;
        Token = token;
        Port = port;
    }

    public string Token { get; }
    public int Port { get; }
    public string Url => $"http://127.0.0.1:{Port}/";
    public JobManager Jobs => _jobs;

    public static async Task<UiServer> StartAsync(UiServerOptions options, CancellationToken ct = default)
    {
        var home = options.ResolveHome();
        var startDirectory = Path.GetFullPath(options.StartDirectory ?? Environment.CurrentDirectory);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var hub = new EventHub();
        var recent = new RecentStore(home);
        var jobs = new JobManager(hub, recent, home, options.Log);

        foreach (var port in new[] { options.Port, 0 })
        {
            var app = Build(options, hub, recent, jobs, token, startDirectory, home, port);
            try
            {
                await app.StartAsync(ct);
            }
            catch (IOException) when (port != 0)
            {
                await app.DisposeAsync();
                continue; // preferred port taken: let the OS pick one
            }

            var address = app.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses.First();
            var actualPort = new Uri(address).Port;
            var server = new UiServer(app, jobs, token, actualPort);
            if (options.InitialPath != null)
            {
                var initial = Directory.Exists(options.InitialPath) ? DirectoryBrowser.ResolveAnalysisTarget(options.InitialPath) : options.InitialPath;
                jobs.StartAnalysis(initial, options.InitialSettings);
            }
            return server;
        }

        throw new InvalidOperationException("Could not start the CodeMap server.");
    }

    private static WebApplication Build(UiServerOptions options, EventHub hub, RecentStore recent, JobManager jobs, string token,
        string startDirectory, string home, int port)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory, Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, port));
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

        var app = builder.Build();
        var html = InjectConfig(options.ViewerHtml, token, startDirectory, home);

        // ------------------------------------------------------------ security
        app.Use(async (context, next) =>
        {
            var port = context.Connection.LocalPort;
            var host = context.Request.Host.Value ?? "";
            var hostOk = host.Equals($"127.0.0.1:{port}", StringComparison.OrdinalIgnoreCase)
                         || host.Equals($"localhost:{port}", StringComparison.OrdinalIgnoreCase)
                         || host.Equals($"[::1]:{port}", StringComparison.OrdinalIgnoreCase);
            if (!hostOk)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                await context.Response.WriteAsync("Invalid host.");
                return;
            }

            if (context.Request.Path.StartsWithSegments("/api"))
            {
                var supplied = context.Request.Headers[TokenHeader].ToString();
                if (string.IsNullOrEmpty(supplied) && context.Request.Path.StartsWithSegments("/api/events")) supplied = context.Request.Query["token"].ToString();
                if (!CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(supplied), System.Text.Encoding.UTF8.GetBytes(token)))
                {
                    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    await context.Response.WriteAsJsonAsync(new { error = "Missing or wrong session token. Reopen the URL printed by `codemap`." });
                    return;
                }
            }

            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["Cache-Control"] = "no-store";
            await next();
        });

        // ------------------------------------------------------------ page
        app.MapGet("/", () => Results.Content(html, "text/html; charset=utf-8"));

        // ------------------------------------------------------------ api
        app.MapGet("/api/config", () => new
        {
            version = typeof(UiServer).Assembly.GetName().Version?.ToString(3),
            startDirectory,
            home,
            watching = jobs.WatchedPath,
            current = jobs.Current?.Describe(),
            languages = LanguageRegistry.Default.Languages.Select(l => new
            {
                id = l.Info.Id,
                name = l.Info.Name,
                inputs = l.Info.InputPatterns,
                problem = l.Unavailable,
            }),
        });

        app.MapGet("/api/browse", (string? path) =>
        {
            try
            {
                return Results.Ok(DirectoryBrowser.Browse(path, startDirectory));
            }
            catch (Exception ex) when (ex is DirectoryNotFoundException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        app.MapGet("/api/recent", () => recent.List());

        app.MapDelete("/api/recent", (string path) => recent.Remove(path) ? Results.NoContent() : Results.NotFound(new { error = "Not in the recent list." }));

        app.MapGet("/api/cache/{key}", (string key) =>
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(key, "^[0-9a-f]{20}$")) return Results.BadRequest(new { error = "Bad key." });
            var file = recent.CacheFile(key);
            return File.Exists(file) ? Results.File(file, "application/json") : Results.NotFound(new { error = "No cached map; analyze the project again." });
        });

        app.MapPost("/api/analyze", (AnalyzeRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path)) return Results.BadRequest(new { error = "Choose a solution, project, package or folder first." });
            try
            {
                var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(request.Path.Trim().Trim('"')));
                if (Directory.Exists(path)) path = DirectoryBrowser.ResolveAnalysisTarget(path);
                var job = jobs.StartAnalysis(path, request.Settings ?? new AnalysisSettings(), live: request.Background);
                return Results.Ok(new { jobId = job.Id, path = job.Path });
            }
            catch (Exception ex) when (ex is FileNotFoundException or ArgumentException or NotSupportedException or IOException)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        app.MapPost("/api/clone", (CloneRequest request) =>
        {
            try
            {
                var job = jobs.StartClone(request.Url, request.Settings ?? new AnalysisSettings());
                return Results.Ok(new { jobId = job.Id });
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        app.MapPost("/api/cancel", () => jobs.Cancel() ? Results.NoContent() : Results.NotFound(new { error = "Nothing is running." }));

        app.MapGet("/api/jobs/current", () => jobs.Current is { } job ? Results.Ok(job.Describe()) : Results.NoContent());

        app.MapGet("/api/jobs/{id}", (string id) => jobs.Get(id) is { } job ? Results.Ok(job.Describe()) : Results.NotFound(new { error = "Unknown job." }));

        app.MapGet("/api/jobs/{id}/graph", (string id) =>
            jobs.Get(id) is { Graph: { } graph } ? Results.Bytes(graph, "application/json") : Results.NotFound(new { error = "The map is not ready." }));

        app.MapPost("/api/watch", (WatchRequest request) =>
        {
            var on = jobs.SetWatch(request.Enabled, request.Path, request.Settings);
            return request.Enabled && !on
                ? Results.BadRequest(new { error = "Analyze a project first, then turn on live updates." })
                : Results.Ok(new { watching = jobs.WatchedPath });
        });

        app.MapGet("/api/events", (HttpContext context) => hub.StreamAsync(context, context.RequestAborted));

        return app;
    }

    /// <summary>Puts the session token next to the data placeholder so the page can call the API.</summary>
    internal static string InjectConfig(string viewerHtml, string token, string startDirectory, string home)
    {
        var index = viewerHtml.IndexOf(HtmlExporter.Placeholder, StringComparison.Ordinal);
        if (index < 0) throw new InvalidDataException("The viewer template does not contain the CodeMap data placeholder.");
        var config = JsonSerializer.Serialize(new { token, startDirectory, home }, Json).Replace("<", "\\u003c", StringComparison.Ordinal); // no markup inside a <script>
        return viewerHtml.Insert(index, $"<script id=\"codemap-server\" type=\"application/json\">{config}</script>");
    }

    public Task WaitForShutdownAsync(CancellationToken ct = default) => Microsoft.Extensions.Hosting.HostingAbstractionsHostExtensions.WaitForShutdownAsync(_app, ct);

    public async ValueTask DisposeAsync()
    {
        _jobs.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}
