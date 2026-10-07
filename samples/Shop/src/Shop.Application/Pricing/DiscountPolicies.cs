using Shop.Application.Orders;
using Shop.Domain.Catalog;
using Shop.Domain.Customers;
using Shop.Domain.Orders;

namespace Shop.Application.Pricing;

public abstract class DiscountPolicy
{
    public abstract string Name { get; }
    public abstract bool AppliesTo(Order order, Customer customer);
    public abstract decimal DiscountFor(Order order, Customer customer);
}

public sealed class LoyaltyDiscount : DiscountPolicy
{
    public override string Name => "Loyalty";

    public override bool AppliesTo(Order order, Customer customer) => customer.Tier != CustomerTier.Regular;

    public override decimal DiscountFor(Order order, Customer customer) => customer.Tier == CustomerTier.Gold ? 0.10m : 0.05m;
}

public sealed class BulkDiscount : DiscountPolicy
{
    public override string Name => "Bulk";

    public override bool AppliesTo(Order order, Customer customer) => order.Lines.Sum(l => l.Quantity) >= 10;

    public override decimal DiscountFor(Order order, Customer customer) => order.Lines.Sum(l => l.Quantity) >= 50 ? 0.15m : 0.07m;
}

public sealed class CategoryDiscount : DiscountPolicy
{
    private readonly ProductCategory _category;
    private readonly decimal _rate;

    public CategoryDiscount(ProductCategory category, decimal rate)
    {
        _category = category;
        _rate = rate;
    }

    public override string Name => $"{_category} sale";

    public override bool AppliesTo(Order order, Customer customer) => order.Lines.Any(l => l.Product.Category == _category);

    public override decimal DiscountFor(Order order, Customer customer) => _rate;
}

public static class DiscountPolicies
{
    // Pricing knows about Orders summaries and Orders knows about Pricing: a namespace cycle on purpose.
    public static string? Describe(Order order) =>
        order.Customer.Tier == CustomerTier.Regular ? null : new LoyaltyDiscount().Name;

    public static OrderSummary? Preview(Order order) => order.Lines.Count == 0 ? null : OrderSummary.From(order);
}
