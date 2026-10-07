namespace Shop.Domain.Common;

/// <summary>Base class for everything that has an identity.</summary>
public abstract class Entity
{
    protected Entity(Guid id) => Id = id;

    public Guid Id { get; }

    public override bool Equals(object? obj) => obj is Entity other && other.GetType() == GetType() && other.Id == Id;

    public override int GetHashCode() => Id.GetHashCode();
}
