namespace Shop.Domain.Common;

/// <summary>An entity that guards a consistency boundary and records domain events.</summary>
public abstract class AggregateRoot : Entity
{
    private readonly List<IDomainEvent> _events = new();

    protected AggregateRoot(Guid id) : base(id)
    {
    }

    public IReadOnlyCollection<IDomainEvent> Events => _events;

    protected void Raise(IDomainEvent domainEvent) => _events.Add(domainEvent);

    public void ClearEvents() => _events.Clear();
}
