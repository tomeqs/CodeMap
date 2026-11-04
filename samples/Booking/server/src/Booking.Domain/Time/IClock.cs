namespace Booking.Domain.Time;

public interface IClock
{
    DateTime UtcNow { get; }
}
