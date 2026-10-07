using System.Diagnostics;

namespace Shop.Api;

public sealed class RequestTimingMiddleware : IMiddleware
{
    private readonly ILogger<RequestTimingMiddleware> _logger;

    public RequestTimingMiddleware(ILogger<RequestTimingMiddleware> logger) => _logger = logger;

    public async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        var watch = Stopwatch.StartNew();
        await next(context);
        _logger.LogInformation("{Path} took {Elapsed} ms", context.Request.Path, watch.ElapsedMilliseconds);
    }
}
