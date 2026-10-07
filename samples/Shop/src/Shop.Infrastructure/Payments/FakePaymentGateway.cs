using Microsoft.Extensions.Logging;
using Shop.Application.Abstractions;
using Shop.Domain.Common;

namespace Shop.Infrastructure.Payments;

internal sealed class FakePaymentGateway(ILogger<FakePaymentGateway> logger, PaymentOptions options) : IPaymentGateway
{
    public async Task<PaymentResult> ChargeAsync(Guid orderId, Money amount, CancellationToken ct)
    {
        await Task.Delay(options.SimulatedLatency, ct);
        if (amount.Amount > options.Limit)
        {
            logger.LogWarning("Payment for {OrderId} declined: {Amount} over limit", orderId, amount);
            return new PaymentResult(false, null, "Limit exceeded");
        }

        return new PaymentResult(true, $"tx-{Guid.NewGuid():N}", null);
    }
}

public sealed class PaymentOptions
{
    public decimal Limit { get; set; } = 10_000m;
    public TimeSpan SimulatedLatency { get; set; } = TimeSpan.FromMilliseconds(50);
}
