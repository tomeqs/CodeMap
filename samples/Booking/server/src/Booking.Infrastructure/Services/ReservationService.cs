using Booking.Domain.Reservations;
using Booking.Domain.Time;
using Booking.Infrastructure.Caching;
using Booking.Infrastructure.Notifications;
using Microsoft.Extensions.DependencyInjection;

namespace Booking.Infrastructure.Services;

/// <summary>Edge case: keyed dependencies. Gets the clock registered under "utc" and the cache under CacheKind.Redis.</summary>
public sealed class ReservationService(
    [FromKeyedServices("utc")] IClock clock,
    [FromKeyedServices(CacheKind.Redis)] ICache cache,
    IReservationRepository repository,
    INotifier notifier)
{
    public Reservation Book(string room, string guest, int nights)
    {
        var reservation = new Reservation(ReservationId.New(), room, guest, nights);
        var problems = new ReservationValidator().Validate(reservation);
        if (problems.Count > 0) throw new ArgumentException(string.Join(" ", problems));

        reservation.Confirm();
        repository.Save(reservation);
        cache.Set($"room:{room}", clock.UtcNow.ToString("O"));
        notifier.Notify(guest, $"Room {room} is yours for {nights} night(s).");
        return reservation;
    }

    public void Cancel(ReservationId id)
    {
        var reservation = ReservationRules.RequireForCancel(repository.Find(id));
        reservation.Cancel();
        repository.Save(reservation);
        notifier.Notify(reservation.GuestName, $"Your reservation of room {reservation.RoomNumber} is cancelled.");
    }
}
