namespace Booking.Infrastructure.Notifications;

public interface INotifier
{
    void Notify(string guest, string message);
}

/// <summary>Registered as an instance through typeof: AddSingleton(typeof(INotifier), new EmailNotifier()).</summary>
public sealed class EmailNotifier : INotifier
{
    public List<string> Sent { get; } = new();

    public void Notify(string guest, string message) => Sent.Add($"{guest}: {message}");
}
