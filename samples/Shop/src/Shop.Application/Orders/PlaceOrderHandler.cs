using Shop.Application.Abstractions;
using Shop.Application.Pricing;
using Shop.Domain.Catalog;
using Shop.Domain.Common;
using Shop.Domain.Customers;
using Shop.Domain.Orders;

namespace Shop.Application.Orders;

/// <summary>Use case: a customer places an order and pays for it.</summary>
public sealed class PlaceOrderHandler : ICommandHandler<PlaceOrderCommand, PlaceOrderResult>
{
    private readonly IOrderRepository _orders;
    private readonly ICatalog _catalog;
    private readonly ICustomerDirectory _customers;
    private readonly PricingCalculator _pricing;
    private readonly IPaymentGateway _payments;
    private readonly IEventBus _events;

    public PlaceOrderHandler(IOrderRepository orders, ICatalog catalog, ICustomerDirectory customers,
        PricingCalculator pricing, IPaymentGateway payments, IEventBus events)
    {
        _orders = orders;
        _catalog = catalog;
        _customers = customers;
        _pricing = pricing;
        _payments = payments;
        _events = events;
    }

    public async Task<PlaceOrderResult> HandleAsync(PlaceOrderCommand command, CancellationToken ct)
    {
        var customer = await _customers.GetAsync(command.CustomerId, ct)
                       ?? throw new DomainException($"Unknown customer {command.CustomerId}");

        var order = new Order(Guid.NewGuid(), customer, "EUR");
        foreach (var item in command.Items)
        {
            var product = await _catalog.GetAsync(item.ProductId, ct);
            if (product is null) return new PlaceOrderResult(order.Id, false, $"Unknown product {item.ProductId}");
            order.AddLine(product, item.Quantity);
        }

        var price = _pricing.Calculate(order, customer, command.Coupon);
        order.Place();
        await _orders.AddAsync(order, ct);

        try
        {
            var payment = await _payments.ChargeAsync(order.Id, price, ct);
            if (!payment.Succeeded) return new PlaceOrderResult(order.Id, false, payment.Error);
            order.MarkPaid();
        }
        catch (TimeoutException)
        {
            return new PlaceOrderResult(order.Id, false, "Payment provider timed out");
        }

        foreach (var domainEvent in order.Events) await _events.PublishAsync(domainEvent, ct);
        order.ClearEvents();
        return new PlaceOrderResult(order.Id, true, null);
    }
}

public interface ICatalog
{
    Task<Product?> GetAsync(Guid productId, CancellationToken ct);
}

public interface ICustomerDirectory
{
    Task<Customer?> GetAsync(Guid customerId, CancellationToken ct);
}
