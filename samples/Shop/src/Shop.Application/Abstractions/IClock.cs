namespace Shop.Application.Abstractions;

public interface IClock
{
    DateTimeOffset Now { get; }
}
