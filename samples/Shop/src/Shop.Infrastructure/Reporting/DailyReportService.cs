using Shop.Application.Orders;

namespace Shop.Infrastructure.Reporting;

/// <summary>Builds the daily sales report.</summary>
/// <remarks>
/// Deliberate DI bug for the demo: this is registered as a singleton but keeps a scoped
/// <see cref="OrderQueries"/> for the lifetime of the application (a captive dependency).
/// </remarks>
public sealed class DailyReportService
{
    private readonly OrderQueries _queries;

    public DailyReportService(OrderQueries queries) => _queries = queries;

    public async Task<int> CountOrdersAsync(Guid customerId, CancellationToken ct) =>
        (await _queries.HistoryAsync(customerId, ct)).Count;
}
