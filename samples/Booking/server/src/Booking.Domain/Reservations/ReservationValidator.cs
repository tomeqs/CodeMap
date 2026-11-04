namespace Booking.Domain.Reservations;

/// <summary>Edge case: a class whose base is generic over another type (Validator&lt;Reservation&gt;) depends on it.</summary>
public sealed class ReservationValidator : Validator<Reservation>
{
    public override IReadOnlyList<string> Validate(Reservation item)
    {
        var problems = new List<string>();
        if (string.IsNullOrWhiteSpace(item.RoomNumber)) problems.Add("A room is needed.");
        if (string.IsNullOrWhiteSpace(item.GuestName)) problems.Add("A guest is needed.");
        if (item.Nights is < 1 or > 30) problems.Add("Between 1 and 30 nights.");
        return problems;
    }
}
