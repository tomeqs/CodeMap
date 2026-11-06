using System.Collections.Concurrent;
using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CodeMap.Mcp.Rendering;

/// <summary>
/// Serves map pages to the rendering browser on 127.0.0.1 (a secure context, which WebGPU needs; a file:// page is not
/// one everywhere). Pages are only served under a random token, and only to requests addressed to the loopback host.
/// </summary>
internal sealed class ViewerHost : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, string> _pages = new(StringComparer.Ordinal);
    private readonly string _token = Guid.NewGuid().ToString("N");
    private WebApplication? _app;

    public string Origin { get; private set; } = "";

    public static async Task<ViewerHost> StartAsync(CancellationToken ct)
    {
        var host = new ViewerHost();
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory, Args = Array.Empty<string>() });
        builder.Logging.ClearProviders(); // stdout is the MCP protocol
        builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, 0));
        var app = builder.Build();
        app.MapGet("/t/{token}/{key}", (HttpContext context, string token, string key) => host.Serve(context, token, key));
        await app.StartAsync(ct).ConfigureAwait(false);
        host._app = app;
        host.Origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First().TrimEnd('/');
        return host;
    }

    /// <summary>Makes a page available and gives its address.</summary>
    public string Publish(string key, string html)
    {
        _pages[key] = html;
        return $"{Origin}/t/{_token}/{key}";
    }

    /// <summary>Whether a request may have the page: the right token, and addressed to this loopback host (no DNS rebinding).</summary>
    internal bool Allowed(string? hostHeader, string token) =>
        token == _token && string.Equals(hostHeader, new Uri(Origin).Authority, StringComparison.OrdinalIgnoreCase);

    private IResult Serve(HttpContext context, string token, string key)
    {
        if (!Allowed(context.Request.Host.Value, token)) return Results.StatusCode(StatusCodes.Status403Forbidden);
        return _pages.TryGetValue(key, out var html) ? Results.Content(html, "text/html; charset=utf-8") : Results.NotFound();
    }

    public async ValueTask DisposeAsync()
    {
        if (_app != null)
        {
            await _app.StopAsync().ConfigureAwait(false);
            await _app.DisposeAsync().ConfigureAwait(false);
        }
    }
}
