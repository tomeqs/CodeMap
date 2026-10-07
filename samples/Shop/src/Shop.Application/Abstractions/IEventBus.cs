using Shop.Domain.Common;

namespace Shop.Application.Abstractions;

public interface IEventBus
{
    event EventHandler<IDomainEvent>? Published;
    Task PublishAsync(IDomainEvent domainEvent, CancellationToken ct);
}
