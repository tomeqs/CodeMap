namespace Booking.Domain.Common;

public interface IRepository<T>
    where T : class
{
    IReadOnlyList<T> All();

    void Save(T item);
}
