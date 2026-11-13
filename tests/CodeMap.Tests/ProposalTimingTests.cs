using CodeMap.Insights;
using CodeMap.Languages;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Tests;

/// <summary>Tests with a time limit run on their own, after the others: beside 250 tests in parallel they measure the machine.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TimedTests
{
    public const string Name = "Timed";
}

[Collection(TimedTests.Name)]
public class ProposalTimingTests
{
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

        var map = ProposalTests.Of(RawGraph.FromDerived(graph, LanguageRegistry.BuiltIn));
        Assert.Equal(20, map.Findings.Findings.Count(f => f.Rule == "cycle.namespace"));
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var proposals = map.Propose(new ProposalRequest { Limit = 3 });
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10), $"took {clock.Elapsed}");
        Assert.Equal(3, proposals.Count);
        Assert.All(proposals, p => Assert.NotNull(p.Predicted));
    }
}
