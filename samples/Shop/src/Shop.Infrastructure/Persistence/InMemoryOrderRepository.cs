using System.Collections.Concurrent;
using Shop.Domain.Orders;

namespace Shop.Infrastructure.Persistence;

internal sealed class InMemoryOrderRepository : IOrderRepository
{
    private readonly ConcurrentDictionary<Guid, Order> _store = new();

    public Task<Order?> FindAsync(Guid id, CancellationToken ct = default) =>
        Task.FromResult(_store.TryGetValue(id, out var order) ? order : null);

    public Task AddAsync(Order order, CancellationToken ct = default)
    {
        _store[order.Id] = order;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<Order>> ForCustomerAsync(Guid customerId, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<Order>>(_store.Values.Where(o => o.Customer.Id == customerId).ToList());
}
