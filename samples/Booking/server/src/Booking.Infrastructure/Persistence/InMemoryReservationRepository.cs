using System.Collections.Concurrent;
using Booking.Domain.Reservations;
using Booking.Infrastructure.Collections;

namespace Booking.Infrastructure.Persistence;

public sealed class InMemoryReservationRepository : IReservationRepository
{
    private readonly ConcurrentDictionary<ReservationId, Reservation> _reservations = new();

    public IReadOnlyList<Reservation> All() => _reservations.Values.ToList();

    public void Save(Reservation item) => _reservations[item.Id] = item;

    public Reservation? Find(ReservationId id) => _reservations.GetValueOrDefault(id);

    public IReadOnlyList<Reservation> ForRoom(string roomNumber) => _reservations.Values.Where(r => r.RoomNumber == roomNumber).ToList();

    public ReservationBook Book() => new(_reservations.Values);
}
