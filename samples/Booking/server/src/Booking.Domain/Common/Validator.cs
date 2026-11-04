namespace Booking.Domain.Common;

/// <summary>Checks an object and lists what is wrong with it.</summary>
public abstract class Validator<T>
{
    public abstract IReadOnlyList<string> Validate(T item);

    public bool IsValid(T item) => Validate(item).Count == 0;
}
