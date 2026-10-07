using Shop.Domain.Common;

namespace Shop.Domain.Orders;

public sealed record OrderPlaced(Guid OrderId, Money Total, DateTimeOffset OccurredAt) : IDomainEvent;

public sealed record OrderCancelled(Guid OrderId, string Reason, DateTimeOffset OccurredAt) : IDomainEvent;
