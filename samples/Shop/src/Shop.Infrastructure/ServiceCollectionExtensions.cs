using Microsoft.Extensions.DependencyInjection;
using Shop.Application.Abstractions;
using Shop.Application.Orders;
using Shop.Application.Pricing;
using Shop.Domain.Catalog;
using Shop.Domain.Orders;
using Shop.Infrastructure.Messaging;
using Shop.Infrastructure.Payments;
using Shop.Infrastructure.Persistence;
using Shop.Infrastructure.Reporting;

namespace Shop.Infrastructure;

public static class ServiceCollectionExtensions
{
    /// <summary>Registers all shop services.</summary>
    public static IServiceCollection AddShop(this IServiceCollection services)
    {
        services.AddSingleton<IOrderRepository, InMemoryOrderRepository>();
        services.AddSingleton<InMemoryCatalog>();
        services.AddSingleton<ICatalog>(sp => sp.GetRequiredService<InMemoryCatalog>());
        services.AddSingleton<ICustomerDirectory>(sp => sp.GetRequiredService<InMemoryCatalog>());
        services.AddSingleton<IPaymentGateway, FakePaymentGateway>();
        services.AddSingleton(new PaymentOptions());
        services.AddSingleton<IEventBus, InProcessEventBus>();
        services.AddSingleton<AuditTrail>();
        services.AddSingleton<IClock, SystemClock>();
        services.AddSingleton<DiscountPolicy, LoyaltyDiscount>();
        services.AddSingleton<DiscountPolicy, BulkDiscount>();
        services.AddSingleton<DiscountPolicy>(new CategoryDiscount(ProductCategory.Books, 0.05m));
        services.AddSingleton<PricingCalculator>();
        services.AddScoped<ICommandHandler<PlaceOrderCommand, PlaceOrderResult>, PlaceOrderHandler>();
        services.AddScoped<OrderQueries>();
        services.AddSingleton<DailyReportService>();
        return services;
    }
}
