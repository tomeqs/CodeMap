using Booking.Domain.Time;

namespace Booking.Infrastructure.Compat;

/// <summary>Compiled on net8.0: Compat/** is only removed for net48.</summary>
public sealed class LegacyClockAdapter(Func<DateTime> now) : IClock
{
    public DateTime UtcNow => now().ToUniversalTime();
}
