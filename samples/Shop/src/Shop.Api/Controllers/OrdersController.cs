using Microsoft.AspNetCore.Mvc;
using Shop.Application.Abstractions;
using Shop.Application.Orders;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/orders")]
public sealed class OrdersController : ControllerBase
{
    private readonly ICommandHandler<PlaceOrderCommand, PlaceOrderResult> _placeOrder;
    private readonly OrderQueries _queries;

    public OrdersController(ICommandHandler<PlaceOrderCommand, PlaceOrderResult> placeOrder, OrderQueries queries)
    {
        _placeOrder = placeOrder;
        _queries = queries;
    }

    [HttpPost]
    public async Task<ActionResult<PlaceOrderResult>> Place(PlaceOrderCommand command, CancellationToken ct)
    {
        var result = await _placeOrder.HandleAsync(command, ct);
        return result.Paid ? Ok(result) : UnprocessableEntity(result);
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<OrderSummary>> Get(Guid id, CancellationToken ct) =>
        await _queries.SummaryAsync(id, ct) is { } summary ? Ok(summary) : NotFound();

    [HttpGet("customer/{customerId:guid}")]
    public Task<IReadOnlyList<OrderSummary>> History(Guid customerId, CancellationToken ct) => _queries.HistoryAsync(customerId, ct);
}
