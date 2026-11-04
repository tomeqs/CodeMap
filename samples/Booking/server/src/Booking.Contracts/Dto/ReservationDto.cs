namespace Booking.Contracts.Dto;

/// <summary>A reservation as the API sends it (client/libs/core/src/contracts.ts mirrors it).</summary>
public sealed record ReservationDto(Guid Id, string Room, string Guest, int Nights, string Status);

public sealed record CreateReservationRequest(string Room, string Guest, int Nights);
