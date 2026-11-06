using CodeMap.Analysis;
using CodeMap.Insights;
using CodeMap.Languages;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Tests;

/// <summary>ProposalEngine: refactorings for findings, checked by simulating them.</summary>
public class ProposalTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };

    private sealed record Map(RawGraph Raw, CodeGraph Graph, GraphIndex Index, FindingsReport Findings)
    {
        public List<Proposal> Propose(ProposalRequest? request = null) => ProposalEngine.Propose(Raw, Graph, Findings, Index, request);
    }

    private static Map Of(RawGraph raw)
    {
        var graph = GraphPipeline.Derive(raw);
        var index = new GraphIndex(graph);
        return new Map(raw, graph, index, FindingsAnalysis.Compute(graph, null, index));
    }

    private static Map Analyze(string path) => Of(GraphPipeline.BuildRaw(path, NoGit, LanguageRegistry.BuiltIn));

    private static readonly Lazy<Map> Shop = new(() => Analyze(Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln")));

    [Fact]
    public void A_proposal_for_a_cycle_removes_it_when_simulated()
    {
        var map = Shop.Value;
        var finding = map.Findings.Findings.First(f => f.Rule == "cycle.namespace");
        var proposals = map.Propose(new ProposalRequest { Finding = finding.Id });

        Assert.NotEmpty(proposals);
        foreach (var proposal in proposals)
        {
            Assert.Contains(finding.Id, proposal.Targets);
            Assert.NotNull(proposal.Predicted);
            Assert.Contains(finding.Id, proposal.Predicted!.Resolved);
            Assert.NotEmpty(proposal.Steps);
            Assert.Contains(proposal.Steps, s => s.Contains(".cs:", StringComparison.Ordinal)); // places in the code

            var simulated = Simulator.Run(map.Raw, proposal.Ops);
            var cycleNodes = map.Graph.Analysis.Cycles.First(c => c.Level == NodeLevels.Namespace && finding.Nodes.All(c.Nodes.Contains)).Nodes;
            Assert.DoesNotContain(simulated.Graph.Analysis.Cycles, c => c.Level == NodeLevels.Namespace && cycleNodes.All(c.Nodes.Contains));
        }
    }

    [Fact]
    public void Proposals_are_deterministic_ordered_by_severity_and_cover_the_kinds_of_shop()
    {
        var first = Shop.Value.Propose(new ProposalRequest { Limit = 20 });
        var again = Shop.Value.Propose(new ProposalRequest { Limit = 20 });
        Assert.Equal(first.Select(p => p.Id), again.Select(p => p.Id));
        Assert.Equal(first.Count, first.Select(p => p.Id).Distinct().Count());
        Assert.Contains(first, p => p.Kind == "fix-di" && p.Ops.OfType<SetLifetimeOp>().Any(o => o.Lifetime == Tags.DiScoped));
        Assert.Contains(first, p => p.Kind == "remove-dead-code");
        Assert.Contains(first, p => p.Kind is "break-cycle" or "move-type");
        Assert.Equal("fix-di", first[0].Kind); // the captive dependency is the only error
        Assert.All(first.Where(p => p.Ops.Count > 0), p => Assert.NotNull(p.Predicted));

        var onlyMoves = Shop.Value.Propose(new ProposalRequest { Kinds = new[] { "move-type" }, Limit = 20 });
        Assert.All(onlyMoves, p => Assert.Equal("move-type", p.Kind));
    }

    [Fact]
    public void A_class_with_two_planted_groups_of_members_is_split_along_them()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", """
            namespace App;
            public class OrderService
            {
                private decimal _price, _discount;
                private string _address = "", _carrier = "";
                public decimal PriceTotal() => PriceBase() - PriceDiscount();
                public decimal PriceBase() => _price;
                public decimal PriceDiscount() => _discount * PriceBase();
                public string ShippingLabel() => ShippingAddress() + ShippingCarrier();
                public string ShippingAddress() => _address;
                public string ShippingCarrier() => _carrier + ShippingAddress();
            }
            """);
        var map = Analyze(ws.Root);
        var groups = MemberClusters.Find(map.Index, "T:App.OrderService");

        Assert.Equal(2, groups.Count);
        var names = groups.Select(g => g.Select(id => map.Index.Node(id)!.Name).Order(StringComparer.Ordinal).ToList()).OrderBy(g => g[0], StringComparer.Ordinal).ToList();
        Assert.Equal(new[] { "PriceBase", "PriceDiscount", "PriceTotal", "_discount", "_price" }, names[0]);
        Assert.Equal(new[] { "ShippingAddress", "ShippingCarrier", "ShippingLabel", "_address", "_carrier" }, names[1]);

        var finding = new Finding { Id = "large-type@T:App.OrderService", Rule = "large-type", Category = FindingCategory.Structure, Severity = FindingSeverity.Info, Title = "t", Message = "m", Nodes = new() { "T:App.OrderService" } };
        var report = new FindingsReport { Findings = new() { finding }, Score = map.Findings.Score };
        var proposal = Assert.Single(ProposalEngine.Propose(map.Raw, map.Graph, report, map.Index, new ProposalRequest { Verify = false }));
        Assert.Equal("split-type", proposal.Kind);
        var split = Assert.IsType<SplitTypeOp>(Assert.Single(proposal.Ops));
        var part = Assert.Single(split.Parts);
        Assert.EndsWith("Service", part.Name);
        Assert.True(part.Name is "PriceService" or "ShippingService", part.Name);
    }

    [Fact]
    public void Feature_envy_dead_code_and_tiny_namespaces_get_their_fix()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", """
            namespace App.Sales
            {
                public class Order { public decimal Price { get; set; } public int Quantity { get; set; } public decimal Discount { get; set; } }
                public class Invoice
                {
                    private int _count;
                    public decimal Total(Order order) => order.Price * order.Quantity - order.Discount;
                    public int Count() => _count;
                    private void Unused() { }
                }
                public class Ledger { public App.Sales.Small.Entry? Last; public App.Sales.Small.Entry Add() => new(); }
                public class Account { public Ledger? Ledger; }
            }
            namespace App.Sales.Small { public class Entry { public decimal Amount; } }
            namespace App.Other { public class Report { } public class Chart { public Report? Of; } }
            """);
        var proposals = Analyze(ws.Root).Propose(new ProposalRequest { Limit = 20 });

        var move = Assert.Single(proposals, p => p.Kind == "move-member");
        Assert.Equal(new MoveMemberOp("M:App.Sales.Invoice.Total(App.Sales.Order)", "T:App.Sales.Order"), Assert.Single(move.Ops));
        Assert.Contains("feature-envy@", move.Predicted!.Resolved[0]);

        var dead = Assert.Single(proposals, p => p.Kind == "remove-dead-code");
        Assert.Equal(new RemoveNodeOp("M:App.Sales.Invoice.Unused"), Assert.Single(dead.Ops));

        var merge = Assert.Single(proposals, p => p.Kind == "merge-namespaces");
        Assert.Equal(new MergeNamespacesOp("namespace:App/App.Sales.Small", "namespace:App/App.Sales"), Assert.Single(merge.Ops));
    }

    [Fact]
    public void Twenty_thousand_types_are_searched_within_ten_seconds()
    {
        // 200 namespaces of 100 types; each namespace uses the next, and every tenth also uses the one before: 2-cycles.
        var graph = new CodeGraph { Source = new SourceInfo { Name = "big", Root = Path.GetTempPath(), Path = Path.GetTempPath(), Kind = "directory" } };
        graph.Nodes.Add(new GraphNode { Id = "project:Big", Kind = NodeKinds.Project, Name = "Big", Language = "csharp" });
        for (var n = 0; n < 200; n++)
        {
            graph.Nodes.Add(new GraphNode { Id = $"namespace:Big/Big.N{n}", Kind = NodeKinds.Namespace, Name = $"Big.N{n}", Parent = "project:Big", Project = "project:Big" });
            for (var t = 0; t < 100; t++)
            {
                graph.Nodes.Add(new GraphNode { Id = $"T:Big.N{n}.T{t}", Kind = NodeKinds.Class, Name = $"T{n}_{t}", FullName = $"Big.N{n}.T{t}", Parent = $"namespace:Big/Big.N{n}", Project = "project:Big", Namespace = $"Big.N{n}", Accessibility = "public", Location = new SourceLocation { File = $"N{n}/T{t}.cs", Line = 1, EndLine = 20 }, Metrics = new() { ["loc"] = 20 } });
                if (t > 0) graph.Edges.Add(new GraphEdge { Source = $"T:Big.N{n}.T{t}", Target = $"T:Big.N{n}.T{t - 1}", Kind = EdgeKinds.Uses });
            }

            if (n + 1 < 200) graph.Edges.Add(new GraphEdge { Source = $"T:Big.N{n}.T0", Target = $"T:Big.N{n + 1}.T99", Kind = EdgeKinds.Uses, Weight = 3 });
            if (n % 10 == 9) graph.Edges.Add(new GraphEdge { Source = $"T:Big.N{n}.T50", Target = $"T:Big.N{n - 1}.T50", Kind = EdgeKinds.Uses });
        }

        var map = Of(RawGraph.FromDerived(graph, LanguageRegistry.BuiltIn));
        Assert.Equal(20, map.Findings.Findings.Count(f => f.Rule == "cycle.namespace"));
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var proposals = map.Propose(new ProposalRequest { Limit = 3 });
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10), $"took {clock.Elapsed}");
        Assert.Equal(3, proposals.Count);
        Assert.All(proposals, p => Assert.NotNull(p.Predicted));
    }
}
