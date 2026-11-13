using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Languages;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Tests;

/// <summary>What-if simulation: operations on a copy of the raw graph, derived again; never the raw graph itself.</summary>
public class SimulatorTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };
    private static readonly Lazy<RawGraph> Shop = new(() => GraphPipeline.BuildRaw(Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln"), NoGit, LanguageRegistry.BuiltIn));

    private static FindingsReport Findings(CodeGraph graph) => FindingsAnalysis.Compute(graph);

    /// <summary>The map as text without the tags a simulation adds.</summary>
    private static string Text(CodeGraph graph)
    {
        var copy = graph.Clone();
        foreach (var node in copy.Nodes)
        {
            node.Tags?.RemoveAll(t => t is Simulator.MovedTag or Simulator.SimulatedTag);
            if (node.Tags is { Count: 0 }) node.Tags = null;
        }

        return GoldenTests.Normalize(copy, GoldenTests.RepoRoot());
    }

    [Fact]
    public void A_simulation_leaves_the_raw_graph_as_it_was_and_a_move_and_its_reverse_give_the_map_back()
    {
        var raw = Shop.Value;
        var before = JsonExporter.Serialize(raw.Graph);
        var original = GraphPipeline.Derive(raw);
        var type = "T:Shop.Application.Orders.OrderSummary";
        var home = original.Nodes.Single(n => n.Id == type).Parent!;

        var there = Simulator.Run(raw, new SimOp[] { new MoveTypeOp(type, "namespace:Shop.Application/Shop.Application.Pricing") });
        Assert.Equal("namespace:Shop.Application/Shop.Application.Pricing", there.Graph.Nodes.Single(n => n.Id == type).Parent);
        Assert.Contains(Simulator.MovedTag, there.Graph.Nodes.Single(n => n.Id == type).Tags!);
        var back = Simulator.Run(there.Raw, new SimOp[] { new MoveTypeOp(type, home) });

        Assert.Equal(before, JsonExporter.Serialize(raw.Graph));
        Assert.Equal(Text(original), Text(back.Graph));
    }

    [Fact]
    public void Cutting_every_upward_dependency_leaves_no_cycle_at_that_level()
    {
        var raw = Shop.Value;
        var original = GraphPipeline.Derive(raw);
        var upward = original.Analysis.Layers.Single(l => l.Level == NodeLevels.Namespace).Upward;
        Assert.NotEmpty(upward);
        Assert.Contains(original.Analysis.Cycles, c => c.Level == NodeLevels.Namespace);

        var result = Simulator.Run(raw, upward.Select(u => (SimOp)new RemoveDependencyOp(u.Source, u.Target)).ToList());

        Assert.DoesNotContain(result.Graph.Analysis.Cycles, c => c.Level == NodeLevels.Namespace);
        Assert.Empty(result.Graph.Analysis.Layers.Single(l => l.Level == NodeLevels.Namespace).Upward);
        Assert.DoesNotContain(Findings(result.Graph).Findings, f => f.Rule == "cycle.namespace");
    }

    [Fact]
    public void Inverting_the_cut_dependency_breaks_the_cycle_through_an_interface_with_its_predicted_id()
    {
        var raw = Shop.Value;
        var result = Simulator.Run(raw, new SimOp[] { new InvertDependencyOp("namespace:Shop.Application/Shop.Application.Pricing", "namespace:Shop.Application/Shop.Application.Orders") });

        var iface = result.Graph.Nodes.Single(n => n.HasTag(Simulator.SimulatedTag) && n.Kind == NodeKinds.Interface);
        Assert.Equal("T:Shop.Application.Pricing.IOrderSummary", iface.Id);
        Assert.Equal("namespace:Shop.Application/Shop.Application.Pricing", iface.Parent);
        Assert.Contains(result.Graph.Edges, e => e.Source == "T:Shop.Application.Orders.OrderSummary" && e.Kind == EdgeKinds.Implements && e.Target == iface.Id);
        Assert.Equal(iface.Id, result.PredictedIds[iface.Id]);
        Assert.DoesNotContain(result.Graph.Analysis.Cycles, c => c.Level == NodeLevels.Namespace && c.Nodes.Contains("namespace:Shop.Application/Shop.Application.Pricing"));
    }

    [Fact]
    public void A_shorter_lifetime_fixes_a_captive_dependency()
    {
        var raw = Shop.Value;
        Assert.Contains(Findings(GraphPipeline.Derive(raw)).Findings, f => f.Rule == "di.captive");
        var result = Simulator.Run(raw, new SimOp[] { new SetLifetimeOp("T:Shop.Infrastructure.Reporting.DailyReportService", Tags.DiScoped) });
        Assert.DoesNotContain(Findings(result.Graph).Findings, f => f.Rule == "di.captive");
    }

    [Fact]
    public void A_batch_with_a_bad_operation_is_rejected_whole()
    {
        var raw = Shop.Value;
        var before = JsonExporter.Serialize(raw.Graph);
        var error = Assert.Throws<SimulationException>(() => Simulator.Run(raw, new SimOp[]
        {
            new SetLifetimeOp("T:Shop.Infrastructure.Reporting.DailyReportService", Tags.DiScoped),
            new MoveTypeOp("T:Shop.Application.Orders.OrderSummary", "T:Shop.Domain.Orders.Order"),
        }));
        Assert.StartsWith("Operation 2 (moveType)", error.Message);
        Assert.Contains("not a namespace", error.Message);
        Assert.Equal(before, JsonExporter.Serialize(raw.Graph));
        Assert.Throws<SimulationException>(() => Simulator.Run(raw, new SimOp[] { new SetLifetimeOp("T:Nope", Tags.DiScoped) }));
        Assert.Throws<SimulationException>(() => Simulator.Run(raw, new SimOp[] { new SetLifetimeOp("T:Shop.Infrastructure.Reporting.DailyReportService", "forever") }));
    }

    [Fact]
    public void Operations_of_one_batch_see_the_tree_the_earlier_ones_left()
    {
        using var ws = new TestWorkspace().Project("App").Project("Lib");
        ws.File("App/A.cs", "namespace App.Orders { public class Order { public int Total() => 1; } public class Line { } } namespace App.Billing { public class Invoice { } }");
        ws.File("Lib/L.cs", "namespace Lib { public class Tool { } }");
        var raw = GraphPipeline.BuildRaw(ws.Root, NoGit, LanguageRegistry.BuiltIn);
        var orders = raw.Graph.Nodes.Single(n => n.Kind == NodeKinds.Namespace && n.Name == "App.Orders").Id;
        var billing = raw.Graph.Nodes.Single(n => n.Kind == NodeKinds.Namespace && n.Name == "App.Billing").Id;
        var lib = raw.Graph.Nodes.Single(n => n.Kind == NodeKinds.Project && n.Name == "Lib").Id;

        // Order moves into App.Billing, then App.Billing moves to Lib: Order and its members go along, Line stays.
        var result = Simulator.Run(raw, new SimOp[] { new MoveTypeOp("T:App.Orders.Order", billing), new MoveNamespaceOp(billing, lib) });

        var moved = result.Graph.Nodes.Single(n => n.Id == "T:App.Orders.Order");
        Assert.Equal((billing, lib), (moved.Parent, moved.Project));
        Assert.Equal(lib, result.Graph.Nodes.Single(n => n.Id == "T:App.Billing.Invoice").Project);
        Assert.All(result.Graph.Nodes.Where(n => n.Parent == "T:App.Orders.Order"), member => Assert.Equal(lib, member.Project));
        Assert.NotEmpty(result.Graph.Nodes.Where(n => n.Parent == "T:App.Orders.Order"));
        Assert.NotEqual(lib, result.Graph.Nodes.Single(n => n.Id == "T:App.Orders.Line").Project);
        // Removing what was just moved takes its members with it.
        var removed = Simulator.Run(raw, new SimOp[] { new MoveTypeOp("T:App.Orders.Order", billing), new RemoveNodeOp(billing) });
        Assert.DoesNotContain(removed.Graph.Nodes, n => n.Id.Contains("App.Orders.Order", StringComparison.Ordinal) || n.Id == "T:App.Billing.Invoice");
        Assert.Contains(removed.Graph.Nodes, n => n.Id == "T:App.Orders.Line");
    }

    [Fact]
    public void Splitting_extracting_merging_and_removing_change_the_structure_as_asked()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", """
            namespace App.Core
            {
                public class Big
                {
                    private int _a, _b;
                    public int A1() => _a; public int A2() => _a + 1;
                    public int B1() => _b; public int B2() => _b + 1;
                }
                public class User { public int Run(Big big) => big.A1() + big.B1(); }
                public class Store { public void Save() { } }
                public class Caller { public void Go(Store store) => store.Save(); }
            }
            namespace App.Tiny { public class Lonely { public int X() => 1; } }
            namespace App.Rest { public class Other { public int Y(App.Tiny.Lonely l) => l.X(); } internal class Dead { private void Never() { } } }
            """);
        var raw = GraphPipeline.BuildRaw(ws.Root, NoGit, LanguageRegistry.BuiltIn);

        var result = Simulator.Run(raw, new SimOp[]
        {
            new SplitTypeOp("T:App.Core.Big", new[] { new SplitPart("BigA", new[] { "A1", "A2", "_a" }), new SplitPart("BigB", new[] { "B1", "B2", "_b" }) }),
            new ExtractInterfaceOp("T:App.Core.Store"),
            new MergeNamespacesOp("namespace:App/App.Tiny", "namespace:App/App.Rest"),
            new RemoveNodeOp("T:App.Rest.Dead"),
        });
        var graph = result.Graph;
        var index = new GraphIndex(graph);

        Assert.Equal("T:App.Core.BigA", index.Node("M:App.Core.Big.A1")!.Parent);
        Assert.Equal("T:App.Core.BigB", index.Node("M:App.Core.Big.B2")!.Parent);
        Assert.Equal(0, index.Node("T:App.Core.Big")!.Metric("members"));
        Assert.NotNull(index.DependencyBetween("T:App.Core.User", "T:App.Core.BigA", NodeLevels.Type));

        Assert.NotNull(index.Node("T:App.Core.IStore"));
        Assert.NotNull(index.DependencyBetween("T:App.Core.Caller", "T:App.Core.IStore", NodeLevels.Type));
        Assert.Null(index.DependencyBetween("T:App.Core.Caller", "T:App.Core.Store", NodeLevels.Type));

        Assert.Null(index.Node("namespace:App/App.Tiny"));
        Assert.Equal("namespace:App/App.Rest", index.Node("T:App.Tiny.Lonely")!.Parent);
        Assert.Null(index.Node("T:App.Rest.Dead"));
        Assert.DoesNotContain(FindingsAnalysis.Compute(graph).Findings, f => f.Rule == "dead-code" && f.Nodes.Contains("T:App.Rest.Dead"));
        Assert.Equal(4, result.Applied.Count);
    }
}
