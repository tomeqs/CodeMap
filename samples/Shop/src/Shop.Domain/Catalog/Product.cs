using Shop.Domain.Common;

namespace Shop.Domain.Catalog;

public sealed class Product : Entity
{
    public Product(Guid id, string name, Money price, ProductCategory category) : base(id)
    {
        Name = name;
        Price = price;
        Category = category;
    }

    public string Name { get; private set; }
    public Money Price { get; private set; }
    public ProductCategory Category { get; }
    public bool IsDiscontinued { get; private set; }

    public void ChangePrice(Money newPrice)
    {
        if (newPrice.Amount <= 0) throw new DomainException("Price must be positive");
        Price = newPrice;
    }

    public void Discontinue() => IsDiscontinued = true;
}

public enum ProductCategory
{
    Books,
    Electronics,
    Garden,
    Toys,
}
