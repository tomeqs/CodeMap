using System.Globalization;

namespace Booking.Domain.Time;

public static class Calendar
{
    public static DateOnly Today(IClock clock) => DateOnly.FromDateTime(clock.UtcNow);

#if NETCOREAPP2_1_OR_GREATER
    /// <summary>Edge case: under an SDK symbol of the target framework (.NET Core 2.1+), so this overload is analyzed.</summary>
    public static DateTime ParseDay(ReadOnlySpan<char> text) =>
        DateTime.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);
#else
    /// <summary>Only for older frameworks: not on the map of net8.0.</summary>
    public static DateTime ParseDay(string text) =>
        DateTime.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);
#endif
}
