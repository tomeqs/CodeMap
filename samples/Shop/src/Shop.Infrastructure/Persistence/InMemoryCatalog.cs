using Shop.Application.Orders;
using Shop.Domain.Catalog;
using Shop.Domain.Common;
using Shop.Domain.Customers;

namespace Shop.Infrastructure.Persistence;

internal sealed class InMemoryCatalog : ICatalog, ICustomerDirectory
{
    private readonly Dictionary<Guid, Product> _products = new();
    private readonly Dictionary<Guid, Customer> _customers = new();

    public InMemoryCatalog()
    {
        Seed();
    }

    public Task<Product?> GetAsync(Guid productId, CancellationToken ct) =>
        Task.FromResult(_products.GetValueOrDefault(productId));

    Task<Customer?> ICustomerDirectory.GetAsync(Guid customerId, CancellationToken ct) =>
        Task.FromResult(_customers.GetValueOrDefault(customerId));

    private void Seed()
    {
        var book = new Product(Guid.NewGuid(), "Domain-Driven Design", new Money(54.90m, "EUR"), ProductCategory.Books);
        var drone = new Product(Guid.NewGuid(), "Camera drone", new Money(499m, "EUR"), ProductCategory.Electronics);
        _products[book.Id] = book;
        _products[drone.Id] = drone;
        var alice = new Customer(Guid.NewGuid(), "alice@example.com", CustomerTier.Gold);
        _customers[alice.Id] = alice;
    }
}
