namespace Shop.Domain.Orders;

public interface IOrderRepository
{
    Task<Order?> FindAsync(Guid id, CancellationToken ct = default);
    Task AddAsync(Order order, CancellationToken ct = default);
    Task<IReadOnlyList<Order>> ForCustomerAsync(Guid customerId, CancellationToken ct = default);
}
