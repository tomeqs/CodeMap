using Booking.Contracts.Dto;
using Booking.Infrastructure.Legacy;
using Booking.Infrastructure.Services;
using Microsoft.AspNetCore.Mvc;

namespace Booking.Api.Controllers;

[ApiController]
[Route("api/rooms")]
public sealed class RoomsController(AvailabilityService availability, PricingService pricing) : ControllerBase
{
    private static readonly string[] Rooms = { "101", "102", "201" };

    [HttpGet]
    public IEnumerable<RoomDto> List() => Rooms.Select(number => new RoomDto(number, availability.IsFree(number), pricing.Quote(1)));

    [HttpPost("import")]
    public IReadOnlyList<string> Import([FromBody] string csv) => new RoomImporter().Parse(csv);
}
