namespace Shop.Domain.Common;

/// <summary>An amount of money in a given currency.</summary>
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0, currency);

    public static Money operator +(Money left, Money right)
    {
        EnsureSameCurrency(left, right);
        return new Money(left.Amount + right.Amount, left.Currency);
    }

    public static Money operator *(Money money, decimal factor) => new(money.Amount * factor, money.Currency);

    private static void EnsureSameCurrency(Money left, Money right)
    {
        if (left.Currency != right.Currency)
        {
            throw new DomainException($"Cannot add {left.Currency} and {right.Currency}");
        }
    }

    public override string ToString() => $"{Amount:0.00} {Currency}";
}
