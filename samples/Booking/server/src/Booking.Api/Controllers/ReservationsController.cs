using Booking.Contracts.Dto;
using Booking.Domain.Reservations;
using Booking.Infrastructure.Services;
using Microsoft.AspNetCore.Mvc;

namespace Booking.Api.Controllers;

/// <summary>Called over HTTP by the TypeScript side (client/apps/bff/src/reservations-api.ts).</summary>
[ApiController]
[Route("api/reservations")]
public sealed class ReservationsController(IReservationRepository repository, ReservationService reservations) : ControllerBase
{
    [HttpGet]
    public IEnumerable<ReservationDto> List() => repository.All().Select(ToDto);

    [HttpGet("{id:guid}")]
    public ActionResult<ReservationDto> Get(Guid id) =>
        repository.Find(new ReservationId(id)) is { } reservation ? ToDto(reservation) : NotFound();

    [HttpPost]
    public ActionResult<ReservationDto> Create(CreateReservationRequest request)
    {
        var reservation = reservations.Book(request.Room, request.Guest, request.Nights);
        return CreatedAtAction(nameof(Get), new { id = reservation.Id.Value }, ToDto(reservation));
    }

    [HttpDelete("{id:guid}")]
    public IActionResult Cancel(Guid id)
    {
        reservations.Cancel(new ReservationId(id));
        return NoContent();
    }

    private static ReservationDto ToDto(Reservation reservation) =>
        new(reservation.Id.Value, reservation.RoomNumber, reservation.GuestName, reservation.Nights, reservation.Status.ToString());
}
