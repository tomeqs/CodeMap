using Booking.Domain.Common;

namespace Booking.Domain.Reservations;

/// <summary>Edge case: an interface that extends a generic interface depends on its argument (Reservation).</summary>
public interface IReservationRepository : IRepository<Reservation>
{
    Reservation? Find(ReservationId id);

    IReadOnlyList<Reservation> ForRoom(string roomNumber);
}
