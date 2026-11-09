using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// samples/shop-ts (the shop in TypeScript: NestJS API, Express gateway, Angular web on a domain library), samples/shop-py
/// (the shop in Python: FastAPI, Django, Flask, Celery on a domain library) and samples/ as a whole (with the C# Shop and
/// Booking): what they are there to show stays on the map.
/// </summary>
public class SampleTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };
    private static string Samples => Path.Combine(GoldenTests.RepoRoot(), "samples");
    private static LanguageRegistry Registry => LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") });

    [NodeFact(typescript: true)]
    public void The_typescript_shop_has_its_packages_routes_containers_cycle_and_dead_code()
    {
        var graph = CodeMapAnalyzer.Analyze(Path.Combine(Samples, "shop-ts"), Registry, NoGit);
        var nodes = graph.Nodes.ToDictionary(n => n.Id);
        const string api = "ts:@shop/api:src/", domain = "ts:@shop/domain:src/", web = "ts:@shop/web:src/app/";
        Assert.Empty(graph.Analysis.Warnings);

        // npm workspace: four packages, the apps on the domain library (read from its sources, nothing installed)
        Assert.Equal(new[] { "@shop/api", "@shop/domain", "@shop/gateway", "@shop/web" },
            graph.Nodes.Where(n => n.Kind == NodeKinds.Project).Select(n => n.Name).OrderBy(n => n, StringComparer.Ordinal));
        Assert.Equal(3, graph.Edges.Count(e => e.Kind == EdgeKinds.ProjectReference && e.Target == "ts:project:@shop/domain"));
        Assert.Contains(graph.Edges, e => e.Kind == EdgeKinds.Calls && e.Source == api + "orders/orders.service.ts#OrdersService.place" && e.Target == domain + "orders/order.ts#Order.addLine");

        // Entry points: Nest handlers (with their HTTP route) and Express routes (with the mount path of their router)
        var routes = graph.Nodes.Where(n => n.Tags?.Contains("route") == true).ToList();
        Assert.Equal("POST /orders/:id/pay", nodes[api + "orders/orders.controller.ts#OrdersController.pay"].Doc);
        Assert.Equal(new[] { "GET /catalog", "GET /catalog/:id", "GET /health", "POST /orders", "POST /orders/:id/pay" },
            routes.Where(n => n.Id.StartsWith("ts:@shop/gateway:", StringComparison.Ordinal)).Select(n => n.Name).OrderBy(n => n, StringComparer.Ordinal));
        Assert.Equal(6, routes.Count(n => n.Id.StartsWith(api, StringComparison.Ordinal)));

        // Containers: Nest's request scope spreading, an interface Nest cannot inject, Angular's unreachable cart
        var di = graph.Analysis.Di!;
        Assert.Equal(
            new[]
            {
                ("interface-injection", "warning", api + "payments/payments.service.ts#PaymentsService"),
                ("scope-bubbling", "info", api + "orders/orders.controller.ts#OrdersController"),
                ("scope-bubbling", "info", api + "orders/orders.service.ts#OrdersService"),
                ("scope-bubbling", "info", api + "payments/payments.controller.ts#PaymentsController"),
                ("scope-bubbling", "info", api + "payments/payments.service.ts#PaymentsService"),
                ("unreachable", "error", web + "checkout.service.ts#CheckoutService"),
            },
            di.Issues.Select(i => (i.Kind, i.Severity, i.Consumer)).OrderBy(i => i.Kind, StringComparer.Ordinal).ThenBy(i => i.Consumer, StringComparer.Ordinal));
        Assert.Equal(new[] { api + "orders/in-memory-order.repository.ts#InMemoryOrderRepository" },
            di.Dependencies.First(d => d.Service == api + "orders/tokens.ts#ORDER_REPOSITORY").Implementations);

        // Orders and payments need each other (forwardRef), a private method nobody calls, a spec file
        Assert.Contains(graph.Analysis.Cycles, c => c.Level == "type" && c.Nodes.SequenceEqual(new[] { api + "orders/orders.service.ts", api + "payments/payments.service.ts" }));
        Assert.Equal(new[] { api + "orders/orders.service.ts#OrdersService.legacyTotal" }, graph.Analysis.UnusedCandidates);
        Assert.Contains("test", nodes[api + "orders/orders.service.spec.ts"].Tags!);
    }

    [PythonFact]
    public void The_python_shop_has_its_projects_routes_container_cycle_and_dead_code()
    {
        var graph = CodeMapAnalyzer.Analyze(Path.Combine(Samples, "shop-py"), Registry, new AnalyzerOptions { Git = false, CodeChecks = true });
        var nodes = graph.Nodes.ToDictionary(n => n.Id);
        const string api = "py:shop-api:src/shop_api/", domain = "py:shop-domain:src/shop_domain/", office = "py:backoffice:orders/";
        Assert.Empty(graph.Analysis.Warnings);
        void Edge(string source, string kind, string target) => Assert.Contains(graph.Edges, e => e.Source == source && e.Kind == kind && e.Target == target);
        string? Doc(string id) => nodes[id].Doc?.Split(" · ")[0];
        bool Tagged(string id, string tag) => nodes[id].Tags?.Contains(tag) == true;

        // A uv workspace: the apps on the domain library, read from its sources (nothing installed), through its re-exports
        Assert.Equal(new[] { "backoffice", "legacy", "shop-api", "shop-domain", "worker" },
            graph.Nodes.Where(n => n.Kind == NodeKinds.Project).Select(n => n.Name).OrderBy(n => n, StringComparer.Ordinal));
        Edge("py:project:shop-api", EdgeKinds.ProjectReference, "py:project:shop-domain");
        Edge("py:project:worker", EdgeKinds.ProjectReference, "py:project:shop-domain");
        Assert.DoesNotContain(graph.Nodes, n => n.Id == "py:pypi:shop-domain");
        Edge(api + "services/orders.py#OrdersService.place", EdgeKinds.Calls, domain + "orders.py#Order.add_line");
        Assert.True(Tagged(domain + "__init__.py", "barrel"));

        // Routes with their full paths: FastAPI routers and includes, Django URLconfs, a DRF router, a Flask blueprint
        Assert.Equal("POST /api/orders/", Doc(api + "routers/orders.py#place_order"));
        Assert.Equal("POST /api/payments/{order_id}", Doc(api + "routers/payments.py#pay_order"));
        Assert.Equal("GET /orders/<int:pk>/", Doc(office + "views.py#OrderDetailView.get"));
        Assert.Equal("/orders/", Doc(office + "views.py#order_list"));
        Assert.Equal("POST /orders/api/{pk}/close/", Doc(office + "views.py#OrderViewSet.close"));
        Assert.Equal("GET /catalog/", Doc("py:legacy:legacy/catalog.py#list_products"));
        Assert.Equal("GET, HEAD /catalog/<sku>", Doc("py:legacy:legacy/catalog.py#show_product"));
        Assert.Equal(10, graph.Nodes.Count(n => n.Tags?.Contains("route") == true));

        // FastAPI's container: lifetimes, endpoints, and the one captive dependency
        var di = graph.Analysis.Di!;
        var issue = Assert.Single(di.Issues);
        Assert.Equal(("captive", api + "deps.py#get_price_list", api + "deps.py#get_session"), (issue.Kind, issue.Consumer, issue.Service));
        Assert.Equal("scoped", di.Registrations.Single(r => r.Service == api + "deps.py#get_session").Lifetime);
        Assert.Equal("singleton", di.Registrations.Single(r => r.Service == api + "deps.py#get_settings").Lifetime);
        Assert.Equal("controller", di.Registrations.Single(r => r.Service == api + "routers/orders.py#place_order").Kind);

        // From the payment route through the Protocol's implementation to the domain
        Edge(api + "services/payments.py#FakePaymentGateway", EdgeKinds.Implements, api + "services/payments.py#PaymentGateway");
        var flows = new CodeMap.Insights.CallFlow(new CodeMap.Insights.GraphIndex(graph));
        var flow = flows.Build(new[] { api + "routers/payments.py#pay_order" });
        Assert.Contains(flow.Methods, m => m.Id == domain + "orders.py#Order.pay");
        Assert.Contains(flow.Methods, m => m.Id == api + "services/payments.py#FakePaymentGateway.charge");

        // Orders and payments need each other; one private method nobody calls
        Assert.Contains(graph.Analysis.Cycles, c => c.Level == "type" && c.Nodes.SequenceEqual(new[] { api + "services/orders.py", api + "services/payments.py" }));
        Assert.Equal(new[] { api + "services/orders.py#OrdersService._legacy_total" }, graph.Analysis.UnusedCandidates);

        // Models of both ORMs, and what Django loads itself
        Assert.True(Tagged(api + "db.py#OrderRow", "entity") && Tagged(office + "models.py#Order", "entity"));
        Edge(api + "db.py#OrderRow.lines", EdgeKinds.Holds, api + "db.py#LineRow");
        Edge(office + "models.py#Order.customer", EdgeKinds.Holds, office + "models.py#Customer");
        Edge(office + "models.py#OrderLine.order", EdgeKinds.Holds, office + "models.py#Order");
        Edge(office + "signals.py#order_saved", "subscribes", office + "models.py#Order");
        foreach (var id in new[] { office + "admin.py", office + "apps.py#OrdersConfig.ready", office + "management/commands/close_stale.py#Command.handle", office + "signals.py#order_saved" })
            Assert.True(Tagged(id, "entrypoint"), id);
        Assert.True(Tagged(office + "middleware.py#AuditMiddleware", "middleware"));
        Assert.True(Tagged("py:backoffice:backoffice/settings.py", "config"));

        // Flask's factory and error handler, Celery tasks called from typer commands, a pytest fixture
        Assert.True(Tagged("py:legacy:legacy/__init__.py#create_app", "entrypoint") && Tagged("py:legacy:legacy/catalog.py#not_found", "entrypoint"));
        Assert.True(Tagged("py:worker:worker/tasks.py#send_receipt", "handler"));
        Edge("py:worker:worker/cli.py#resend", EdgeKinds.Calls, "py:worker:worker/tasks.py#send_receipt");
        Edge("py:shop-api:tests/test_orders.py#test_place_keeps_the_lines", EdgeKinds.Calls, "py:shop-api:tests/conftest.py#service");

        // --checks: the mutable default of the legacy app
        var diagnostic = Assert.Single(graph.Analysis.Diagnostics!);
        Assert.Equal(("mutable-default", "apps/legacy/legacy/catalog.py", "py:legacy:legacy/catalog.py#show_product"), (diagnostic.Rule, diagnostic.Location.File, diagnostic.Node));
    }

    [NodeFact(typescript: true, python: true)]
    public void The_samples_folder_is_one_map_of_csharp_typescript_and_python()
    {
        var graph = CodeMapAnalyzer.Analyze(Samples, Registry, NoGit);
        Assert.Equal(new[] { "csharp", "python", "typescript" }, graph.Source.Languages!.Select(l => l.Id));
        var projects = graph.Nodes.Where(n => n.Kind == NodeKinds.Project).ToList();
        Assert.Equal(9, projects.Count(p => p.Language == "csharp"));     // Shop 5, Booking 4
        Assert.Equal(7, projects.Count(p => p.Language == "typescript")); // shop-ts 4, Booking 3
        Assert.Equal(5, projects.Count(p => p.Language == "python"));     // shop-py
        Assert.Contains(graph.Nodes, n => n.Id == "py:shop-domain:src/shop_domain/orders.py#Order");
        Assert.Contains(graph.Nodes, n => n.Id == "T:Shop.Domain.Orders.Order");
        Assert.Contains(graph.Nodes, n => n.Id == "ts:@shop/domain:src/orders/order.ts#Order");
        Assert.Contains(graph.Nodes, n => n.Id == "T:Booking.Domain.Reservations.Reservation");
        Assert.Contains(graph.Nodes, n => n.Id == "ts:@booking/core:src/http-client.ts#HttpClient");
        Assert.Empty(graph.Analysis.Warnings);
    }
}
