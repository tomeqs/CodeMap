using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// samples/shop-ts (the shop in TypeScript: NestJS API, Express gateway, Angular web on a domain library) and
/// samples/ as a whole (with the C# Shop): what they are there to show stays on the map.
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

    [NodeFact(typescript: true)]
    public void The_samples_folder_is_one_map_of_csharp_and_typescript()
    {
        var graph = CodeMapAnalyzer.Analyze(Samples, Registry, NoGit);
        Assert.Equal(new[] { "csharp", "typescript" }, graph.Source.Languages!.Select(l => l.Id));
        var projects = graph.Nodes.Where(n => n.Kind == NodeKinds.Project).ToList();
        Assert.Equal(5, projects.Count(p => p.Language == "csharp"));
        Assert.Equal(4, projects.Count(p => p.Language == "typescript"));
        Assert.Contains(graph.Nodes, n => n.Id == "T:Shop.Domain.Orders.Order");
        Assert.Contains(graph.Nodes, n => n.Id == "ts:@shop/domain:src/orders/order.ts#Order");
        Assert.Empty(graph.Analysis.Warnings);
    }
}
