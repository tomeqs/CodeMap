using System.Text;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Languages;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Tests;

/// <summary>
/// The raw graph and the finished map as two steps (GraphPipeline.BuildRaw / Derive): deriving again gives the same
/// map, leaves the raw graph as it was, and a saved map goes back to its raw graph.
/// </summary>
public class RecomputeTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };
    private static string Shop => Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln");
    private static string TsMini => Path.Combine(GoldenTests.RepoRoot(), "tests", "CodeMap.Tests", "Golden", "ts-mini.fragment.json");
    private static LanguageRegistry Fragments => new(new[] { new FragmentLanguage() });

    private static string Text(CodeGraph graph) => GoldenTests.Normalize(graph, GoldenTests.RepoRoot());

    public static IEnumerable<object[]> Inputs => new[] { new object[] { "shop" }, new object[] { "ts-mini" } };

    private static (string Path, LanguageRegistry Registry) Input(string name) => name switch
    {
        "shop" => (Shop, LanguageRegistry.BuiltIn),
        "ts-mini" => (TsMini, Fragments),
        "booking" => (BookingSampleTests.Booking, BookingSampleTests.Registry),
        _ => throw new ArgumentException(name),
    };

    [Theory]
    [MemberData(nameof(Inputs))]
    public void Deriving_the_raw_graph_gives_the_same_map_as_one_run(string name) => AssertDeriveMatchesRun(name);

    [NodeFact(typescript: true)]
    public void Deriving_the_raw_booking_graph_gives_the_same_map_as_one_run() => AssertDeriveMatchesRun("booking");

    private static void AssertDeriveMatchesRun(string name)
    {
        var (path, registry) = Input(name);
        var run = GraphPipeline.Run(path, NoGit, registry);
        var raw = GraphPipeline.BuildRaw(path, NoGit, registry);
        var rawBefore = JsonExporter.Serialize(raw.Graph);

        var first = GraphPipeline.Derive(raw);
        var second = GraphPipeline.Derive(raw);

        Assert.Equal(Text(run), Text(first));
        Assert.Equal(Text(first), Text(second));
        Assert.Equal(rawBefore, JsonExporter.Serialize(raw.Graph));
    }

    [Theory]
    [MemberData(nameof(Inputs))]
    public void A_saved_map_goes_back_to_its_raw_graph(string name) => AssertSavedMapRederives(name);

    [NodeFact(typescript: true)]
    public void A_saved_booking_map_goes_back_to_its_raw_graph() => AssertSavedMapRederives("booking");

    private static void AssertSavedMapRederives(string name)
    {
        var (path, registry) = Input(name);
        var run = GraphPipeline.Run(path, NoGit, registry);
        var saved = Reload(run);

        var raw = RawGraph.FromDerived(saved, registry);
        var again = GraphPipeline.Derive(raw);

        Assert.Equal(Text(run), Text(again));
        Assert.DoesNotContain(raw.Graph.Nodes, n => n.Tags?.Contains(Tags.InCycle) == true || n.Tags?.Contains(Tags.Unused) == true);
        Assert.Empty(raw.Graph.Analysis.Cycles);
        Assert.Empty(raw.Graph.Analysis.Layers);
    }

    [Fact]
    public void A_copy_of_a_map_is_the_same_map_and_shares_nothing_mutable()
    {
        var graph = GraphPipeline.Run(Shop, NoGit, LanguageRegistry.BuiltIn);
        var original = JsonExporter.Serialize(graph);
        var copy = graph.Clone();

        Assert.Equal(original, JsonExporter.Serialize(copy));

        var node = copy.Nodes.First(n => n.Metrics != null && n.Tags != null);
        node.SetMetric("loc", -1);
        node.AddTag("changed");
        copy.Edges[0].Weight = 999;
        copy.Analysis.Di!.Registrations[0].Lifetime = "changed";
        copy.Analysis.Layers[0].Layers[0].Add("changed");
        Assert.Equal(original, JsonExporter.Serialize(graph));
    }

    [Fact]
    public void A_changed_raw_graph_is_derived_without_stale_metrics_tags_or_cycles()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App.One; public class A { public App.Two.B? B; public void Run() => B!.Go(); }");
        ws.File("App/B.cs", "namespace App.Two; public class B { public App.One.A? A; public void Go() { } }");
        var raw = GraphPipeline.BuildRaw(ws.Root, NoGit, LanguageRegistry.BuiltIn);

        var before = GraphPipeline.Derive(raw);
        Assert.Contains(before.Analysis.Cycles, c => c.Level == "namespace");
        Assert.True(before.Node("T:App.One.A").HasTag(Tags.InCycle));
        Assert.Equal(1, before.Node("M:App.Two.B.Go").Metric("fanIn"));

        // Without A's edges to B, the cycle is gone and so is the caller of Go.
        var changed = raw.Graph.Clone();
        changed.Edges.RemoveAll(e => e.Source.StartsWith("F:App.One.A.B", StringComparison.Ordinal) || e.Source.StartsWith("M:App.One.A.Run", StringComparison.Ordinal));
        var after = GraphPipeline.Derive(raw.With(changed));

        Assert.DoesNotContain(after.Analysis.Cycles, c => c.Level == "namespace");
        Assert.False(after.Node("T:App.One.A").HasTag(Tags.InCycle));
        Assert.Equal(0, after.Node("M:App.Two.B.Go").Metric("fanIn"));
        Assert.Equal(0, after.Node("T:App.One.A").Metric("ce"));

        // The same graph, saved and derived again, has no leftovers either.
        var reread = GraphPipeline.Derive(RawGraph.FromDerived(Reload(after), LanguageRegistry.BuiltIn));
        Assert.Equal(Text(after), Text(reread));
    }

    [Fact]
    public void Git_data_is_read_once_and_kept_for_saved_maps_and_simulations()
    {
        using var ws = new TestWorkspace().Project("App").Git("init", "-q");
        string Version(string type, int v) => $"namespace App; public class {type} {{ public int V{v} => {v}; }}";
        for (var v = 1; v <= 3; v++) ws.Commit("c" + v, ("App/Rules.cs", Version("Rules", v)), ("App/Format.cs", Version("Format", v)));
        var options = new AnalyzerOptions();

        var run = GraphPipeline.Run(ws.Root, options, LanguageRegistry.BuiltIn);
        var raw = GraphPipeline.BuildRaw(ws.Root, options, LanguageRegistry.BuiltIn);
        Assert.NotNull(raw.History);
        Assert.DoesNotContain(raw.Graph.Edges, e => e.Kind == EdgeKinds.ChangesWith);

        var derived = GraphPipeline.Derive(raw);
        Assert.Equal(Text(run), Text(derived));
        Assert.Single(derived.Analysis.ChangeCoupling);
        Assert.Equal(3, derived.Node("T:App.Rules").Metric("commits"));

        // A saved map keeps its git data although the history is not read again.
        var saved = RawGraph.FromDerived(Reload(derived), LanguageRegistry.BuiltIn);
        Assert.Null(saved.History);
        Assert.DoesNotContain(saved.Graph.Edges, e => e.Kind == EdgeKinds.ChangesWith);
        Assert.Equal(0, saved.Graph.Node("T:App.Rules").Metric("commits"));
        Assert.Equal(Text(derived), Text(GraphPipeline.Derive(saved)));

        // Git data taken from a finished map gives the same as the history.
        Assert.Equal(Text(derived), Text(GraphPipeline.Derive(raw, new DeriveOptions { GitFrom = derived })));
    }

    [Fact]
    public void Steps_can_be_left_out()
    {
        var raw = GraphPipeline.BuildRaw(Shop, NoGit, LanguageRegistry.BuiltIn);
        var metricsOnly = GraphPipeline.Derive(raw, new DeriveOptions { Steps = DeriveSteps.Metrics });

        Assert.NotEmpty(metricsOnly.Analysis.Cycles);
        Assert.Empty(metricsOnly.Analysis.Layers);
        Assert.Empty(metricsOnly.Stats);
    }

    [Fact]
    public void Index_finds_nodes_by_id_full_name_name_and_the_end_of_a_full_name()
    {
        var index = new GraphIndex(GraphPipeline.Run(Shop, NoGit, LanguageRegistry.BuiltIn));
        var type = index.Graph.Nodes.First(n => NodeLevels.IsType(n) && !n.External && n.FullName != null && n.FullName.Count(c => c == '.') >= 2);

        Assert.Same(type, index.Resolve(type.Id).Node);
        Assert.Same(type, index.Resolve(type.FullName!).Node);
        var tail = string.Join('.', type.FullName!.Split('.').TakeLast(2));
        Assert.Contains(type, index.Resolve(tail).Candidates);
        Assert.False(index.Resolve("NoSuchThing").Found);
        Assert.Equal(NodeLevels.Type, NodeLevels.Of(index.Node(index.TypeOf(index.Children(type.Id).First(NodeLevels.IsMember).Id)!)!));
    }

    [Fact]
    public void Index_reports_an_ambiguous_name_with_its_candidates()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App.One { public class Handler { } } namespace App.Two { public class Handler { } }");
        var index = new GraphIndex(ws.Analyze());

        var resolution = index.Resolve("Handler");
        Assert.False(resolution.Found);
        Assert.Equal(new[] { "App.One.Handler", "App.Two.Handler" }, resolution.Candidates.Select(c => c.FullName));
        Assert.Equal("T:App.Two.Handler", index.Resolve("Two.Handler").Node?.Id);
        Assert.Equal("T:App.One.Handler", index.Resolve("one.handler").Node?.Id);
    }

    [Fact]
    public void Index_rolls_dependencies_up_to_a_level_with_the_code_behind_them()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", """
            namespace App.Web;
            public class Controller
            {
                private readonly App.Data.Store _store = new();
                public void Get()
                {
                    _store.Load();
                }
            }
            """);
        ws.File("App/B.cs", "namespace App.Data; public class Store { public void Load() { } }");
        var index = new GraphIndex(ws.Analyze());

        var types = index.DependencyBetween("T:App.Web.Controller", "T:App.Data.Store", NodeLevels.Type)!;
        Assert.Contains(EdgeKinds.Calls, types.Kinds.Keys);
        var call = types.Edges.Single(e => e.Kind == EdgeKinds.Calls);
        Assert.Equal(new CodeRef("App/A.cs", 7), index.Where(call));

        var namespaces = index.DependencyBetween("namespace:App/App.Web", "namespace:App/App.Data", NodeLevels.Namespace)!;
        Assert.Equal(types.Weight, namespaces.Weight);
        Assert.Single(index.DependenciesOf("namespace:App/App.Web", NodeLevels.Namespace));
        Assert.Single(index.DependentsOf("namespace:App/App.Data", NodeLevels.Namespace));
        Assert.Null(index.DependencyBetween("namespace:App/App.Data", "namespace:App/App.Web", NodeLevels.Namespace));
    }

    private static CodeGraph Reload(CodeGraph graph)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(JsonExporter.Serialize(graph)));
        return JsonExporter.Read(stream);
    }
}
