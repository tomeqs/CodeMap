namespace Shop.Application.Orders;

public sealed record PlaceOrderCommand(Guid CustomerId, IReadOnlyList<PlaceOrderCommand.Item> Items, string? Coupon)
{
    public sealed record Item(Guid ProductId, int Quantity);
}

public sealed record PlaceOrderResult(Guid OrderId, bool Paid, string? Error);
