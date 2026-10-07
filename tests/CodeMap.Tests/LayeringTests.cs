using CodeMap.Analysis;

namespace CodeMap.Tests;

public class LayeringTests
{
    [Fact]
    public void Dependencies_point_down_and_the_lightest_cycle_edge_points_up()
    {
        // Api → App → Domain, and Domain → App only once (the architecture mistake).
        var result = Layering.Compute(
            new[] { "Api", "App", "Domain", "Lonely" },
            new[] { ("Api", "App", 3), ("App", "Domain", 5), ("Domain", "App", 1), ("Api", "Domain", 1) });

        Assert.Equal(0, result.LayerOf["Domain"]);
        Assert.Equal(1, result.LayerOf["App"]);
        Assert.Equal(2, result.LayerOf["Api"]);
        Assert.Equal(0, result.LayerOf["Lonely"]);
        var upward = Assert.Single(result.Upward);
        Assert.Equal(("Domain", "App", 1), (upward.Source, upward.Target, upward.Weight));
        Assert.Equal(new[] { "Domain", "Lonely" }, result.Layers[0]);
    }

    [Fact]
    public void Acyclic_graphs_have_no_upward_edges()
    {
        var nodes = Enumerable.Range(0, 30).Select(i => "n" + i).ToList();
        var edges = new List<(string, string, int)>();
        for (var i = 0; i < 30; i++)
        {
            for (var j = i + 1; j < 30; j += 3) edges.Add(("n" + i, "n" + j, 1 + (i * j) % 4));
        }

        var result = Layering.Compute(nodes, edges);

        Assert.Empty(result.Upward);
        foreach (var (source, target, _) in edges) Assert.True(result.LayerOf[source] > result.LayerOf[target]);
    }

    [Fact]
    public void Analyzer_reports_layers_for_namespaces_and_projects()
    {
        using var ws = new TestWorkspace()
            .Project("Core")
            .Project("Web", references: "Core")
            .File("Core/Domain.cs", """
                namespace Shop.Domain;
                public class Order { public Shop.Services.Pricing? Pricing { get; set; } }
                """)
            .File("Core/Services.cs", """
                namespace Shop.Services;
                public class Pricing { public decimal Price(Shop.Domain.Order o) => 1; public decimal Twice(Shop.Domain.Order o) => Price(o) * 2; public Shop.Domain.Order Make() => new(); }
                """)
            .File("Web/Page.cs", """
                namespace Shop.Web;
                public class Page { public Shop.Services.Pricing Pricing { get; } = new(); }
                """);

        var graph = ws.Analyze();

        var projects = graph.Analysis.Layers.Single(l => l.Level == "project");
        Assert.Equal(new[] { "project:Core" }, projects.Layers[0]);
        Assert.Equal(new[] { "project:Web" }, projects.Layers[1]);
        Assert.Empty(projects.Upward);

        var namespaces = graph.Analysis.Layers.Single(l => l.Level == "namespace");
        Assert.Equal(3, namespaces.Layers.Count);
        Assert.Equal("namespace:Web/Shop.Web", Assert.Single(namespaces.Layers[2]));
        var upward = Assert.Single(namespaces.Upward);
        Assert.Equal(("namespace:Core/Shop.Domain", "namespace:Core/Shop.Services"), (upward.Source, upward.Target));
    }
}
