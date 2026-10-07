namespace Shop.Domain.Common;

/// <summary>Thrown when a business rule is violated.</summary>
public class DomainException : Exception
{
    public DomainException(string message) : base(message)
    {
    }
}
