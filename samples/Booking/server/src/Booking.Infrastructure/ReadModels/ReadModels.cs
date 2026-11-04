using Booking.Domain.Reservations;
using Booking.Infrastructure.Persistence;

namespace Booking.Infrastructure.ReadModels;

/// <summary>One generic service, registered twice with different type arguments (see AddBooking()).</summary>
public interface IReadModel<T>
{
    IReadOnlyList<T> Load();
}

/// <summary>Registered as IReadModel&lt;Reservation&gt;, a singleton. Reads the concrete store, which a cast forward registers.</summary>
public sealed class ReservationReadModel(InMemoryReservationRepository store) : IReadModel<Reservation>
{
    public IReadOnlyList<Reservation> Load() => store.All();
}

/// <summary>Registered as IReadModel&lt;string&gt;, scoped, after the one above.</summary>
public sealed class RoomNumbers(IReservationRepository repository) : IReadModel<string>
{
    public IReadOnlyList<string> Load() => repository.All().Select(r => r.RoomNumber).Distinct().ToList();
}

/// <summary>
/// Edge case: a singleton that asks for IReadModel&lt;Reservation&gt;. It gets ReservationReadModel, not the scoped
/// IReadModel&lt;string&gt; registered after it, so it holds no scoped service.
/// </summary>
public sealed class OccupancyReport(IReadModel<Reservation> reservations)
{
    public int Booked() => reservations.Load().Count(r => r.Status == ReservationStatus.Confirmed);
}
