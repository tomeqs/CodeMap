namespace Booking.Domain.Reservations;

/// <summary>A room booked by a guest for some nights. Edge case: the generic argument of the base (ReservationId) is a dependency.</summary>
public sealed class Reservation : Entity<ReservationId>
{
    public Reservation(ReservationId id, string roomNumber, string guestName, int nights)
    {
        Id = id;
        RoomNumber = roomNumber;
        GuestName = guestName;
        Nights = nights;
    }

    public string RoomNumber { get; }

    public string GuestName { get; }

    public int Nights { get; }

    public ReservationStatus Status { get; private set; } = ReservationStatus.Pending;

    public void Confirm()
    {
        if (Status != ReservationStatus.Pending) throw new InvalidOperationException($"A {Status} reservation cannot be confirmed.");
        Status = ReservationStatus.Confirmed;
    }

    public void Cancel()
    {
        if (!ReservationRules.CanCancel(this)) throw new InvalidOperationException("Only confirmed reservations can be cancelled.");
        Status = ReservationStatus.Cancelled;
    }
}
