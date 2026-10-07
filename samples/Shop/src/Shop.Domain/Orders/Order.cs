using Shop.Domain.Catalog;
using Shop.Domain.Common;
using Shop.Domain.Customers;

namespace Shop.Domain.Orders;

/// <summary>A customer's order – the central aggregate of the shop.</summary>
public sealed class Order : AggregateRoot
{
    private readonly List<OrderLine> _lines = new();

    public Order(Guid id, Customer customer, string currency) : base(id)
    {
        Customer = customer;
        Currency = currency;
        customer.Attach(this);
    }

    public Customer Customer { get; }
    public string Currency { get; }
    public OrderStatus Status { get; private set; } = OrderStatus.Draft;
    public IReadOnlyList<OrderLine> Lines => _lines;
    public Money Total => _lines.Aggregate(Money.Zero(Currency), (sum, line) => sum + line.Total);

    public void AddLine(Product product, int quantity)
    {
        if (Status != OrderStatus.Draft) throw new DomainException("Only draft orders can be changed");
        if (product.IsDiscontinued) throw new DomainException($"{product.Name} is discontinued");
        if (quantity <= 0) throw new ArgumentOutOfRangeException(nameof(quantity));

        var existing = _lines.FirstOrDefault(l => l.Product.Id == product.Id);
        if (existing != null)
        {
            existing.Increase(quantity);
            return;
        }

        _lines.Add(new OrderLine(product, quantity));
    }

    public void Place()
    {
        if (_lines.Count == 0) throw new DomainException("Cannot place an empty order");
        Status = OrderStatus.Placed;
        Raise(new OrderPlaced(Id, Total, DateTimeOffset.UtcNow));
    }

    public void MarkPaid()
    {
        if (Status != OrderStatus.Placed) throw new DomainException("Only placed orders can be paid");
        Status = OrderStatus.Paid;
    }

    public void Cancel(string reason)
    {
        switch (Status)
        {
            case OrderStatus.Draft:
            case OrderStatus.Placed:
                Status = OrderStatus.Cancelled;
                Raise(new OrderCancelled(Id, reason, DateTimeOffset.UtcNow));
                break;
            case OrderStatus.Paid:
                throw new DomainException("Paid orders must be refunded instead");
            default:
                break;
        }
    }
}

public sealed class OrderLine
{
    public OrderLine(Product product, int quantity)
    {
        Product = product;
        Quantity = quantity;
    }

    public Product Product { get; }
    public int Quantity { get; private set; }
    public Money Total => Product.Price * Quantity;

    internal void Increase(int quantity) => Quantity += quantity;
}

public enum OrderStatus
{
    Draft,
    Placed,
    Paid,
    Cancelled,
}
