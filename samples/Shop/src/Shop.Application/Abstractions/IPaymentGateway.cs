using Shop.Domain.Common;

namespace Shop.Application.Abstractions;

public interface IPaymentGateway
{
    Task<PaymentResult> ChargeAsync(Guid orderId, Money amount, CancellationToken ct);
}

public sealed record PaymentResult(bool Succeeded, string? TransactionId, string? Error);
