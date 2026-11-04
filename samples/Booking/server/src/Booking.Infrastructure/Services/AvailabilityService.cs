using Booking.Domain.Reservations;
using Booking.Infrastructure.Caching;

namespace Booking.Infrastructure.Services;

/// <summary>
/// Edge case: asks for ICache without a key, but ICache is only registered under keys. The container cannot
/// give it one, and the map reports it (with a hint to use [FromKeyedServices]).
/// </summary>
public sealed class AvailabilityService(ICache cache, IReservationRepository repository)
{
    public bool IsFree(string roomNumber)
    {
        if (cache.TryGet($"room:{roomNumber}", out _)) return false;
        return repository.ForRoom(roomNumber).All(r => r.Status == ReservationStatus.Cancelled);
    }
}
