using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http;

namespace CodeMap.Server;

/// <summary>Server-sent events: pushes job progress and "graph ready" notices to every open browser tab.</summary>
public sealed class EventHub
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<Guid, Channel<string>> _clients = new();

    public int ClientCount => _clients.Count;

    public void Publish(object message)
    {
        var json = JsonSerializer.Serialize(message, Json);
        foreach (var channel in _clients.Values) channel.Writer.TryWrite(json);
    }

    public async Task StreamAsync(HttpContext context, CancellationToken ct)
    {
        var response = context.Response;
        response.Headers.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        response.Headers["X-Accel-Buffering"] = "no";

        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(2000) { FullMode = BoundedChannelFullMode.DropOldest });
        var id = Guid.NewGuid();
        _clients[id] = channel;
        try
        {
            await response.WriteAsync("retry: 2000\n\n", ct);
            await response.Body.FlushAsync(ct);
            while (!ct.IsCancellationRequested)
            {
                using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(ct);
                heartbeat.CancelAfter(TimeSpan.FromSeconds(15));
                try
                {
                    var message = await channel.Reader.ReadAsync(heartbeat.Token);
                    await response.WriteAsync($"data: {message}\n\n", ct);
                    while (channel.Reader.TryRead(out var more)) await response.WriteAsync($"data: {more}\n\n", ct);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    await response.WriteAsync(": ping\n\n", ct);
                }

                await response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException)
        {
            // client went away
        }
        finally
        {
            _clients.TryRemove(id, out _);
        }
    }
}
