using System.Text.Json;
using System.Text.Json.Nodes;
using CodeMap.Export;
using CodeMap.Model;

namespace CodeMap.Mcp.Rendering;

/// <summary>What to show: a view of the map at a level, with something selected, highlighted or followed.</summary>
internal sealed record RenderRequest
{
    public string View { get; init; } = "galaxy";
    public string? Level { get; init; }
    public string? Focus { get; init; }
    public string Mode { get; init; } = "neighbors";
    public (string From, string To)? Path { get; init; }
    public CycleInfo? Cycle { get; init; }
    public DiIssue? DiIssue { get; init; }
    public IReadOnlyList<string>? FlowRoots { get; init; }
    public IReadOnlyList<string>? Highlight { get; init; }
    public string? HighlightText { get; init; }
    public int Width { get; init; } = 1280;
    public int Height { get; init; } = 800;
}

internal sealed record RenderResult(byte[] Png, JsonElement Description, List<string> Errors, bool Settled);

/// <summary>Rendering needs a browser and there is none (or it cannot draw).</summary>
internal sealed class RenderUnavailableException(string message) : Exception(message);

/// <summary>
/// Renders the 3D map to PNG with a headless Chromium: the viewer with the graph embedded, served from 127.0.0.1,
/// driven through its automation API (window.codemap: setView, setLevel, select, showCycle…, idle, describe), then a
/// screenshot. The browser and the page are kept between renders (the layout of a graph is computed once) and closed
/// after 10 minutes without a render.
/// </summary>
internal sealed class MapRenderer : IAsyncDisposable
{
    private static readonly TimeSpan IdleClose = TimeSpan.FromMinutes(10);

    private readonly Func<string?> _viewerHtml;
    private readonly string? _browser;
    private readonly TextWriter _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Timer _idle;
    private ChromiumProcess? _chrome;
    private CdpClient? _cdp;
    private CdpPage? _page;
    private ViewerHost? _host;
    private CodeGraph? _shown;
    private int _pages;

    public MapRenderer(Func<string?> viewerHtml, string? browser, TextWriter log)
    {
        _viewerHtml = viewerHtml;
        _browser = browser;
        _log = log;
        _idle = new Timer(_ => _ = CloseIfIdleAsync(), null, Timeout.Infinite, Timeout.Infinite);
    }

    /// <summary>The renderer the viewer uses: WebGL 2 unless CODEMAP_RENDERER says webgpu (WebGL is steadier on SwiftShader).</summary>
    public static string Renderer => Environment.GetEnvironmentVariable("CODEMAP_RENDERER") is "webgpu" ? "webgpu" : "webgl";

    public async Task<RenderResult> RenderAsync(CodeGraph graph, RenderRequest request, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _idle.Change(Timeout.Infinite, Timeout.Infinite);
            var page = await PageAsync(ct).ConfigureAwait(false);
            await page.SetViewportAsync(request.Width, request.Height, ct).ConfigureAwait(false);
            if (!ReferenceEquals(_shown, graph))
            {
                var template = _viewerHtml() ?? throw new RenderUnavailableException("This build of CodeMap has no viewer to render with.");
                var url = _host!.Publish($"map{++_pages}.html", HtmlExporter.Export(graph, template)) + $"?motion=off&renderer={Renderer}";
                _shown = null;
                await page.NavigateAsync(url, ct).ConfigureAwait(false);
                var ready = await page.EvaluateAsync(
                    "new Promise((resolve) => { const t0 = performance.now(); const wait = () => window.codemap?.model ? resolve(true) : performance.now() - t0 > 60000 ? resolve(false) : setTimeout(wait, 50); wait(); })",
                    ct, TimeSpan.FromSeconds(90)).ConfigureAwait(false);
                if (ready.ValueKind != JsonValueKind.True)
                {
                    var errors = page.TakeErrors();
                    throw new RenderUnavailableException("The map did not start in the headless browser" + (errors.Count > 0 ? $": {string.Join("; ", errors.Take(3))}" : "."));
                }

                _shown = graph;
            }

            var options = new JsonObject
            {
                ["view"] = request.View,
                ["level"] = request.Level,
                ["focus"] = request.Focus,
                ["mode"] = request.Mode,
                ["path"] = request.Path is { } p ? new JsonArray(p.From, p.To) : null,
                ["cycle"] = request.Cycle == null ? null : JsonSerializer.SerializeToNode(request.Cycle, JsonExporter.Options),
                ["diIssue"] = request.DiIssue == null ? null : JsonSerializer.SerializeToNode(request.DiIssue, JsonExporter.Options),
                ["flowRoots"] = request.FlowRoots == null ? null : new JsonArray(request.FlowRoots.Select(r => (JsonNode)r).ToArray()),
                ["highlight"] = request.Highlight == null ? null : new JsonArray(request.Highlight.Select(r => (JsonNode)r).ToArray()),
                ["highlightText"] = request.HighlightText,
                ["timeout"] = 60000,
            };

            const string Script = """
                (async (o) => {
                  const app = window.codemap;
                  const errors = [];
                  const run = (what, f) => { try { f(); } catch (e) { errors.push(`${what}: ${e?.message ?? e}`); } };
                  run('reset', () => app.select(null));
                  // The map only: the filter panel says nothing in a picture.
                  if (!document.getElementById('left')?.classList.contains('collapsed')) document.getElementById('left-toggle')?.click();
                  if (o.flowRoots) run('flow', () => app.showFlow(o.flowRoots));
                  else if (o.view) run('view', () => app.setView(o.view));
                  if (o.level) run('level', () => app.setLevel(o.level));
                  if (o.cycle) run('cycle', () => app.showCycle(o.cycle));
                  if (o.diIssue) run('di', () => app.showDiIssue(o.diIssue));
                  if (o.path) run('path', () => app.showPath(o.path[0], o.path[1]));
                  if (o.focus) run('focus', () => app.select(o.focus, { focus: true, mode: o.mode || 'neighbors' }));
                  if (o.highlight) run('highlight', () => app.highlight(o.highlight, o.highlightText));
                  const settled = await app.idle({ timeout: o.timeout });
                  return { settled, errors, ...app.describe() };
                })
                """;
            var description = await page.EvaluateAsync($"{Script}({options.ToJsonString()})", ct, TimeSpan.FromSeconds(120)).ConfigureAwait(false);
            var png = await page.ScreenshotAsync(ct).ConfigureAwait(false);
            var pageErrors = page.TakeErrors();
            if (description.TryGetProperty("errors", out var scriptErrors)) pageErrors.AddRange(scriptErrors.EnumerateArray().Select(e => e.GetString() ?? ""));
            var settled = description.TryGetProperty("settled", out var s) && s.ValueKind == JsonValueKind.True;
            return new RenderResult(png, description, pageErrors, settled);
        }
        catch (Exception ex) when (ex is CdpException or TimeoutException or System.Net.WebSockets.WebSocketException)
        {
            await CloseAsync().ConfigureAwait(false); // start over next time
            throw new RenderUnavailableException($"Rendering failed: {ex.Message}");
        }
        finally
        {
            _idle.Change(IdleClose, Timeout.InfiniteTimeSpan);
            _gate.Release();
        }
    }

    private async Task<CdpPage> PageAsync(CancellationToken ct)
    {
        if (_page != null && _chrome is { HasExited: false }) return _page;
        await CloseAsync().ConfigureAwait(false);
        var executable = BrowserLocator.Find(_browser) ?? throw new RenderUnavailableException(
            $"No Chrome, Edge or Chromium was found to render the map with: install one, or point {BrowserLocator.EnvironmentVariable} (or codemap mcp --browser) at its executable.");
        _log.WriteLine($"render: starting {executable}");
        try
        {
            _chrome = await ChromiumProcess.StartAsync(executable, Renderer == "webgpu", ct, _log).ConfigureAwait(false);
            _cdp = await CdpClient.ConnectAsync(_chrome.WebSocketUrl, ct).ConfigureAwait(false);
            _page = await CdpPage.OpenAsync(_cdp, ct).ConfigureAwait(false);
            _host ??= await ViewerHost.StartAsync(ct).ConfigureAwait(false);
            return _page;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or CdpException or System.Net.WebSockets.WebSocketException or TimeoutException)
        {
            await CloseAsync().ConfigureAwait(false);
            throw new RenderUnavailableException($"The browser ({executable}) could not be started for rendering: {ex.Message}");
        }
    }

    private async Task CloseIfIdleAsync()
    {
        if (!await _gate.WaitAsync(0).ConfigureAwait(false)) return;
        try
        {
            await CloseAsync().ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task CloseAsync()
    {
        _page = null;
        _shown = null;
        // The browser first: killing it is what matters, and its DevTools socket then closes at once.
        if (_chrome != null) await _chrome.DisposeAsync().ConfigureAwait(false);
        _chrome = null;
        if (_cdp != null) await _cdp.DisposeAsync().ConfigureAwait(false);
        _cdp = null;
    }

    public async ValueTask DisposeAsync()
    {
        await _idle.DisposeAsync().ConfigureAwait(false);
        await CloseAsync().ConfigureAwait(false);
        if (_host != null) await _host.DisposeAsync().ConfigureAwait(false);
        _host = null;
    }
}
