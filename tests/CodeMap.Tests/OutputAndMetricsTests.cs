using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>History metrics that do not mislead, and maps reduced to types that stay consistent.</summary>
public class OutputAndMetricsTests
{
    [Fact]
    public void A_type_over_several_files_counts_each_commit_once()
    {
        using var ws = new TestWorkspace().Project("App").Git("init", "-q");
        ws.Commit("both halves", ("App/Store.A.cs", "namespace App;\npublic partial class Store { public int A => 1; }\n"), ("App/Store.B.cs", "namespace App;\npublic partial class Store { public int B => 2; }\n"));
        ws.Commit("one half", ("App/Store.B.cs", "namespace App;\npublic partial class Store { public int B => 3; }\n"));

        var store = ws.Analyze(options: new AnalyzerOptions()).Node("T:App.Store");

        Assert.Equal(2, store.Metric("commits")); // not 3: the first commit touched both files
        Assert.Equal(6, store.Metric("churn"));   // the lines of both files: 2 + 2, then 1 added and 1 deleted
    }

    [Fact]
    public void A_shallow_clone_is_reported_with_its_few_commits()
    {
        using var origin = new TestWorkspace().Project("App").Git("init", "-q");
        origin.Commit("one", ("App/A.cs", "namespace App; public class A { int V1; }"));
        origin.Commit("two", ("App/A.cs", "namespace App; public class A { int V2; }"));
        using var clone = new TestWorkspace().Git("clone", "-q", "--depth", "1", "file://" + origin.Root, ".");

        var graph = clone.Analyze(options: new AnalyzerOptions());

        Assert.True(graph.Source.Git!.Shallow);
        Assert.Equal(1, graph.Source.Git.CommitsAnalyzed);
        Assert.Contains(graph.Analysis.Warnings, w => w.StartsWith("The repository is a shallow clone with only 1 commit(s)", StringComparison.Ordinal));
        Assert.False(origin.Analyze(options: new AnalyzerOptions()).Source.Git!.Shallow);
    }

    [Fact]
    public void Types_only_points_DI_registrations_at_types_and_counts_what_remains()
    {
        using var ws = new TestWorkspace()
            .Project("App", sdk: "Microsoft.NET.Sdk.Web")
            .File("App/Setup.cs", """
                using Microsoft.Extensions.DependencyInjection;
                namespace App;
                public interface IClock { }
                public class Clock : IClock { }
                public static class Setup
                {
                    public static IServiceCollection AddApp(this IServiceCollection services) => services.AddSingleton<IClock, Clock>();
                }
                """);
        var graph = ws.Analyze();

        GraphView.CollapseMembers(graph);

        Assert.Equal("T:App.Setup", Assert.Single(graph.Analysis.Di!.Registrations).RegisteredIn); // was M:App.Setup.AddApp(…)
        Assert.Equal(0, graph.Stats["members"]);
        Assert.Equal(graph.Edges.Count, graph.Stats["edges"]);
        Assert.Equal(graph.Nodes.Count(n => n.Kind == NodeKinds.Class || n.Kind == NodeKinds.Interface), graph.Stats["types"]);
    }
}
