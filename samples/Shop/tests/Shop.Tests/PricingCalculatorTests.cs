using Shop.Application.Abstractions;
using Shop.Application.Pricing;
using Shop.Domain.Catalog;
using Shop.Domain.Common;
using Shop.Domain.Customers;
using Shop.Domain.Orders;

namespace Shop.Tests;

public class PricingCalculatorTests
{
    private sealed class FixedClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset Now { get; } = now;
    }

    [Fact]
    public void Gold_customers_get_loyalty_discount()
    {
        var customer = new Customer(Guid.NewGuid(), "a@b.c", CustomerTier.Gold);
        var order = new Order(Guid.NewGuid(), customer, "EUR");
        order.AddLine(new Product(Guid.NewGuid(), "Book", new Money(100, "EUR"), ProductCategory.Books), 1);
        var calculator = new PricingCalculator(new DiscountPolicy[] { new LoyaltyDiscount() }, new FixedClock(DateTimeOffset.UnixEpoch));

        var price = calculator.Calculate(order, customer, coupon: null);

        Assert.Equal(90m, price.Amount);
    }

    [Theory]
    [InlineData("VIP", 85)]
    [InlineData("NOPE", 100)]
    public void Coupons_are_applied(string coupon, decimal expected)
    {
        var customer = new Customer(Guid.NewGuid(), "a@b.c", CustomerTier.Gold);
        var order = new Order(Guid.NewGuid(), customer, "EUR");
        order.AddLine(new Product(Guid.NewGuid(), "Drone", new Money(100, "EUR"), ProductCategory.Electronics), 1);
        var calculator = new PricingCalculator(Array.Empty<DiscountPolicy>(), new FixedClock(DateTimeOffset.UnixEpoch));

        Assert.Equal(expected, calculator.Calculate(order, customer, coupon).Amount);
    }
}
