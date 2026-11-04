using Booking.Domain.Common;

namespace Booking.Domain.Reservations;

public static class ReservationRules
{
    /// <summary>Edge case: a property pattern reads Status and Nights (accesses edges).</summary>
    public static bool CanCancel(Reservation reservation) =>
        reservation is { Status: ReservationStatus.Confirmed, Nights: > 0 };

    /// <summary>Edge case: nameof(Reservation.Cancel) names the method without calling it (no calls edge).</summary>
    public static Reservation RequireForCancel(Reservation? reservation) =>
        Guard.NotNull(reservation, nameof(Reservation.Cancel));
}
