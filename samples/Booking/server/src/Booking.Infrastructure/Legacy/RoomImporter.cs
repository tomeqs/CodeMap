namespace Booking.Infrastructure.Legacy;

/// <summary>Compiled: the project removes Legacy/** and then includes this file again.</summary>
public sealed class RoomImporter
{
    public IReadOnlyList<string> Parse(string csv) =>
        csv.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Skip(1).Select(line => line.Split(',')[0]).ToList();
}
