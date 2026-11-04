namespace Booking.Infrastructure.Resilience;

public sealed record RetryPolicy(int Attempts);

/// <summary>
/// Edge case: named "…Controller" but not an ASP.NET controller (no ControllerBase, no [ApiController]). It is not
/// tagged controller and the container does not build it, so its unregistered RetryPolicy is not reported.
/// </summary>
public sealed class RetryController(RetryPolicy policy)
{
    public bool ShouldRetry(int attempt) => attempt < policy.Attempts;
}
