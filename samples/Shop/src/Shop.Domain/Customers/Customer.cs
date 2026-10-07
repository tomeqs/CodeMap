using Shop.Domain.Common;
using Shop.Domain.Orders;

namespace Shop.Domain.Customers;

public sealed class Customer : AggregateRoot
{
    private readonly List<Order> _orders = new();

    public Customer(Guid id, string email, CustomerTier tier) : base(id)
    {
        Email = email;
        Tier = tier;
    }

    public string Email { get; }
    public CustomerTier Tier { get; private set; }
    public IReadOnlyList<Order> Orders => _orders;

    public void Attach(Order order) => _orders.Add(order);

    public Money LifetimeValue(string currency) =>
        _orders.Where(o => o.Status == OrderStatus.Paid).Aggregate(Money.Zero(currency), (sum, o) => sum + o.Total);

    public void Promote()
    {
        Tier = Tier switch
        {
            CustomerTier.Regular => CustomerTier.Silver,
            CustomerTier.Silver => CustomerTier.Gold,
            _ => Tier,
        };
    }
}

public enum CustomerTier
{
    Regular,
    Silver,
    Gold,
}
