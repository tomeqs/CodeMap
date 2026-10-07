using Shop.Application.Abstractions;
using Shop.Domain.Catalog;
using Shop.Domain.Common;
using Shop.Domain.Customers;
using Shop.Domain.Orders;

namespace Shop.Application.Pricing;

/// <summary>Applies discount policies, coupons and seasonal rules to an order.</summary>
public class PricingCalculator
{
    private readonly IReadOnlyList<DiscountPolicy> _policies;
    private readonly IClock _clock;

    public PricingCalculator(IEnumerable<DiscountPolicy> policies, IClock clock)
    {
        _policies = policies.ToList();
        _clock = clock;
    }

    public Money Calculate(Order order, Customer customer, string? coupon)
    {
        var total = order.Total;
        var best = 0m;
        foreach (var policy in _policies)
        {
            if (!policy.AppliesTo(order, customer)) continue;
            var discount = policy.DiscountFor(order, customer);
            if (discount > best) best = discount;
        }

        if (!string.IsNullOrWhiteSpace(coupon))
        {
            best += coupon.ToUpperInvariant() switch
            {
                "WELCOME10" when customer.Orders.Count <= 1 => 0.10m,
                "BOOKWORM" when order.Lines.Any(l => l.Product.Category == ProductCategory.Books) => 0.05m,
                "VIP" when customer.Tier == CustomerTier.Gold => 0.15m,
                _ => 0m,
            };
        }

        if (IsBlackFriday(_clock.Now) && customer.Tier != CustomerTier.Regular) best += 0.05m;
        best = Math.Min(best, 0.5m);
        return total * (1 - best);
    }

    private static bool IsBlackFriday(DateTimeOffset now) =>
        now.Month == 11 && now.DayOfWeek == DayOfWeek.Friday && now.Day >= 23 && now.Day <= 29;
}
