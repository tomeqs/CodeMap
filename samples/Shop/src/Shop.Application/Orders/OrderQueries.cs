using Shop.Application.Pricing;
using Shop.Domain.Orders;

namespace Shop.Application.Orders;

public sealed class OrderQueries
{
    private readonly IOrderRepository _orders;

    public OrderQueries(IOrderRepository orders) => _orders = orders;

    public async Task<OrderSummary?> SummaryAsync(Guid id, CancellationToken ct)
    {
        var order = await _orders.FindAsync(id, ct);
        return order is null ? null : OrderSummary.From(order);
    }

    public async Task<IReadOnlyList<OrderSummary>> HistoryAsync(Guid customerId, CancellationToken ct)
    {
        var orders = await _orders.ForCustomerAsync(customerId, ct);
        return orders.Select(OrderSummary.From).ToList();
    }

    // Nobody calls this any more.
    private static string LegacyFormat(Order order) => $"{order.Id}:{order.Status}";
}

public sealed record OrderSummary(Guid Id, string Status, decimal Total, string Currency, string? AppliedDiscount)
{
    public static OrderSummary From(Order order) =>
        new(order.Id, order.Status.ToString(), order.Total.Amount, order.Currency, DiscountPolicies.Describe(order));
}
