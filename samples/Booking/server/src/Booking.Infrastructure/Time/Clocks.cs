using Booking.Domain.Time;

namespace Booking.Infrastructure.Time;

public sealed class SystemClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}

/// <summary>Registered under the key "utc", and by Booking.Api as the override of the default clock.</summary>
public sealed class UtcClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}

/// <summary>Registered with TryAdd after SystemClock: the container ignores it.</summary>
public sealed class FixedClock : IClock
{
    public DateTime UtcNow { get; init; } = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
}
