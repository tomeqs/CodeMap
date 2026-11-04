namespace Booking.Domain.Common;

/// <summary>Something with an identity of its own.</summary>
public abstract class Entity<TId>
    where TId : notnull
{
    public TId Id { get; protected init; } = default!;
}
