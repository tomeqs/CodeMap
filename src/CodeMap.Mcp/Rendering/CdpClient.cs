using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeMap.Mcp.Rendering;

/// <summary>An error the browser answered a DevTools command with.</summary>
internal sealed class CdpException(string message) : Exception(message);

/// <summary>
/// A small Chrome DevTools Protocol client over a WebSocket: commands with ids and their answers, and events, for the
/// browser and for pages attached to it (flat sessions).
/// </summary>
internal sealed class CdpClient : IAsyncDisposable
{
    private readonly ClientWebSocket _socket = new();
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _send = new(1, 1);
    private Task? _receiving;
    private int _id;

    /// <summary>An event: its method, parameters and the session it came from (null for the browser).</summary>
    public event Action<string, JsonElement, string?>? Event;

    public static async Task<CdpClient> ConnectAsync(string url, CancellationToken ct)
    {
        var client = new CdpClient();
        client._socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
        await client._socket.ConnectAsync(new Uri(url), ct).ConfigureAwait(false);
        client._receiving = Task.Run(client.ReceiveAsync);
        return client;
    }

    public async Task<JsonElement> SendAsync(string method, object? parameters = null, string? sessionId = null, CancellationToken ct = default, TimeSpan? timeout = null)
    {
        var id = Interlocked.Increment(ref _id);
        var waiting = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = waiting;
        var message = new JsonObject { ["id"] = id, ["method"] = method };
        if (parameters != null) message["params"] = JsonSerializer.SerializeToNode(parameters);
        if (sessionId != null) message["sessionId"] = sessionId;
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await _send.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        finally
        {
            _send.Release();
        }

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(timeout ?? TimeSpan.FromSeconds(60));
        using var registration = limit.Token.Register(() => waiting.TrySetCanceled());
        try
        {
            return await waiting.Task.ConfigureAwait(false);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"The browser did not answer {method}.");
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    private async Task ReceiveAsync()
    {
        var buffer = new byte[1 << 16];
        using var message = new MemoryStream();
        try
        {
            while (!_stop.IsCancellationRequested && _socket.State == WebSocketState.Open)
            {
                var result = await _socket.ReceiveAsync(buffer, _stop.Token).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close) break;
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;
                Dispatch(message.ToArray());
                message.SetLength(0);
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
        }
        finally
        {
            foreach (var waiting in _pending.Values) waiting.TrySetException(new CdpException("The browser closed the connection."));
        }
    }

    private void Dispatch(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        var session = root.TryGetProperty("sessionId", out var s) ? s.GetString() : null;
        if (root.TryGetProperty("id", out var idElement) && _pending.TryGetValue(idElement.GetInt32(), out var waiting))
        {
            if (root.TryGetProperty("error", out var error)) waiting.TrySetException(new CdpException(error.TryGetProperty("message", out var m) ? m.GetString() ?? "error" : error.GetRawText()));
            else waiting.TrySetResult(root.TryGetProperty("result", out var result) ? result.Clone() : default);
            return;
        }

        if (root.TryGetProperty("method", out var method))
        {
            Event?.Invoke(method.GetString() ?? "", root.TryGetProperty("params", out var p) ? p.Clone() : default, session);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        try
        {
            // Bounded: a browser that no longer answers must not hold up closing.
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            if (_socket.State == WebSocketState.Open) await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
        }

        if (_receiving != null) await Task.WhenAny(_receiving, Task.Delay(2000)).ConfigureAwait(false);
        _socket.Dispose();
        _stop.Dispose();
    }
}

/// <summary>One page of the browser: navigate, evaluate scripts, size the viewport, take screenshots; with its errors.</summary>
internal sealed class CdpPage
{
    private readonly CdpClient _client;
    private readonly string _session;
    private readonly List<string> _errors = new();
    private TaskCompletionSource? _loaded;

    private CdpPage(CdpClient client, string session)
    {
        _client = client;
        _session = session;
        client.Event += OnEvent;
    }

    public static async Task<CdpPage> OpenAsync(CdpClient client, CancellationToken ct)
    {
        var target = await client.SendAsync("Target.createTarget", new { url = "about:blank" }, ct: ct).ConfigureAwait(false);
        var attached = await client.SendAsync("Target.attachToTarget", new { targetId = target.GetProperty("targetId").GetString(), flatten = true }, ct: ct).ConfigureAwait(false);
        var page = new CdpPage(client, attached.GetProperty("sessionId").GetString()!);
        await page.SendAsync("Page.enable", null, ct).ConfigureAwait(false);
        await page.SendAsync("Runtime.enable", null, ct).ConfigureAwait(false);
        return page;
    }

    /// <summary>Errors the page reported since the last call (exceptions, console errors), and clears them.</summary>
    public List<string> TakeErrors()
    {
        lock (_errors)
        {
            var copy = _errors.ToList();
            _errors.Clear();
            return copy;
        }
    }

    public Task<JsonElement> SendAsync(string method, object? parameters, CancellationToken ct, TimeSpan? timeout = null) =>
        _client.SendAsync(method, parameters, _session, ct, timeout);

    public async Task NavigateAsync(string url, CancellationToken ct)
    {
        var loaded = _loaded = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await SendAsync("Page.navigate", new { url }, ct).ConfigureAwait(false);
        var finished = await Task.WhenAny(loaded.Task, Task.Delay(TimeSpan.FromSeconds(60), ct)).ConfigureAwait(false);
        if (finished != loaded.Task) throw new TimeoutException("The map page did not load within 60 s.");
    }

    public Task SetViewportAsync(int width, int height, CancellationToken ct) =>
        SendAsync("Emulation.setDeviceMetricsOverride", new { width, height, deviceScaleFactor = 1, mobile = false }, ct);

    /// <summary>Runs a script (awaiting a promise it returns) and gives back its value as JSON.</summary>
    public async Task<JsonElement> EvaluateAsync(string expression, CancellationToken ct, TimeSpan? timeout = null)
    {
        var result = await SendAsync("Runtime.evaluate", new { expression, awaitPromise = true, returnByValue = true }, ct, timeout).ConfigureAwait(false);
        if (result.TryGetProperty("exceptionDetails", out var details))
        {
            var text = details.TryGetProperty("exception", out var ex) && ex.TryGetProperty("description", out var d) ? d.GetString() : details.GetProperty("text").GetString();
            throw new CdpException($"The page failed: {text}");
        }

        return result.GetProperty("result").TryGetProperty("value", out var value) ? value.Clone() : default;
    }

    public async Task<byte[]> ScreenshotAsync(CancellationToken ct)
    {
        var shot = await SendAsync("Page.captureScreenshot", new { format = "png" }, ct, TimeSpan.FromSeconds(90)).ConfigureAwait(false);
        return Convert.FromBase64String(shot.GetProperty("data").GetString()!);
    }

    private void OnEvent(string method, JsonElement parameters, string? session)
    {
        if (session != _session) return;
        switch (method)
        {
            case "Page.loadEventFired":
                _loaded?.TrySetResult();
                break;
            case "Runtime.exceptionThrown":
                var details = parameters.GetProperty("exceptionDetails");
                var text = details.TryGetProperty("exception", out var ex) && ex.TryGetProperty("description", out var d) ? d.GetString() : details.GetProperty("text").GetString();
                lock (_errors) _errors.Add($"exception: {text?.Split('\n')[0]}");
                break;
            case "Runtime.consoleAPICalled" when parameters.GetProperty("type").GetString() == "error":
                var args = parameters.GetProperty("args").EnumerateArray().Select(a => a.TryGetProperty("value", out var v) ? v.ToString() : a.TryGetProperty("description", out var desc) ? desc.GetString() : "").ToList();
                lock (_errors) _errors.Add($"console: {string.Join(" ", args).Split('\n')[0]}");
                break;
        }
    }
}
