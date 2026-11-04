using System.Collections;
using Booking.Domain.Reservations;

namespace Booking.Infrastructure.Collections;

/// <summary>Edge case: explicit implementations of framework interfaces are called through them, never "unused".</summary>
public sealed class ReservationBook(IEnumerable<Reservation> reservations) : IEnumerable<Reservation>, IDisposable
{
    private readonly List<Reservation> _items = reservations.ToList();

    public IEnumerator<Reservation> GetEnumerator() => _items.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    void IDisposable.Dispose() => _items.Clear();
}
