using Booking.Domain.Time;

namespace Booking.Infrastructure.Services;

/// <summary>
/// Edge case: gets the clock that wins. AddBooking() registers SystemClock (and a TryAdd of FixedClock that the
/// container ignores); Booking.Api registers UtcClock after calling AddBooking(), so PricingService gets UtcClock.
/// </summary>
public sealed class PricingService(IClock clock)
{
    private const decimal PricePerNight = 120m;

    public decimal Quote(int nights)
    {
        var today = Calendar.Today(clock);
        var weekend = today.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday;
        return nights * PricePerNight * (weekend ? 1.2m : 1m);
    }
}
