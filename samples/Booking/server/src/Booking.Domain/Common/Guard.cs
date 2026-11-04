namespace Booking.Domain.Common;

public static class Guard
{
    public static T NotNull<T>(T? value, string what)
        where T : class
        => value ?? throw new ArgumentNullException(what, $"{what} needs a value.");
}
