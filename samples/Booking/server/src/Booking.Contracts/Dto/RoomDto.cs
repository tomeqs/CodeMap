namespace Booking.Contracts.Dto;

public sealed record RoomDto(string Number, bool Free, decimal PricePerNight);
