using Shop.Application.Abstractions;
using Shop.Domain.Common;

namespace Shop.Infrastructure.Messaging;

internal sealed class InProcessEventBus : IEventBus
{
    public event EventHandler<IDomainEvent>? Published;

    public Task PublishAsync(IDomainEvent domainEvent, CancellationToken ct)
    {
        Published?.Invoke(this, domainEvent);
        return Task.CompletedTask;
    }
}

internal sealed class AuditTrail
{
    private readonly List<string> _entries = new();

    public AuditTrail(IEventBus bus)
    {
        bus.Published += OnPublished;
    }

    public IReadOnlyList<string> Entries => _entries;

    private void OnPublished(object? sender, IDomainEvent e) => _entries.Add($"{e.OccurredAt:O} {e.GetType().Name}");
}

internal sealed class SystemClock : IClock
{
    public DateTimeOffset Now => DateTimeOffset.UtcNow;
}
