using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Languages.External;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>Runs only where Node.js is installed (and, for the TypeScript plugin, its npm install was done); CI requires both.</summary>
public sealed class NodeFactAttribute : FactAttribute
{
    public NodeFactAttribute(bool typescript = false)
    {
        if (Environment.GetEnvironmentVariable("CODEMAP_REQUIRE_NODE") == "1") return;
        if (RuntimeLocator.SearchPath("node") == null) Skip = "Node.js is not installed.";
        else if (typescript && !Directory.Exists(Path.Combine(GoldenTests.RepoRoot(), "analyzers", "typescript", "node_modules", "typescript")))
            Skip = "Run npm install in analyzers/typescript.";
    }
}

/// <summary>Languages as separate programs: the stub plugin (tests/CodeMap.Tests/Plugins/stub) and the real TypeScript one.</summary>
public class PluginTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };
    private static string StubFolder => Path.Combine(GoldenTests.RepoRoot(), "tests", "CodeMap.Tests", "Plugins", "stub");

    private static (LanguageRegistry Registry, ExternalProcessAnalyzer Stub) Stub()
    {
        var registry = LanguageRegistry.WithPlugins(new[] { StubFolder });
        return (registry, (ExternalProcessAnalyzer)registry.Find("stub")!);
    }

    [NodeFact]
    public void A_plugin_gets_the_request_and_its_graph_joins_the_map()
    {
        using var ws = new TestWorkspace().File("stub.json", "{}").File("a.stub", "").File("deep/b.stub", "");
        var (registry, _) = Stub();

        var graph = CodeMapAnalyzer.Analyze(ws.Root, registry, new AnalyzerOptions { Git = false, IncludeTests = false });

        // The request (echoed by the stub).
        var request = System.Text.Json.JsonDocument.Parse(graph.Node("stub:project").Doc!).RootElement;
        Assert.Equal(1, request.GetProperty("protocol").GetInt32());
        Assert.Equal("analyze", request.GetProperty("command").GetString());
        Assert.Equal(Path.GetFullPath(ws.Root), request.GetProperty("target").GetString());
        Assert.Equal(Path.GetFullPath(ws.Root), request.GetProperty("root").GetString());
        Assert.False(request.GetProperty("options").GetProperty("includeTests").GetBoolean());

        // Its nodes with the shared analysis on top; what does not belong is dropped and reported.
        Assert.Equal("deep/b.stub", graph.Node("stub:b.stub").Location!.File);
        Assert.Equal(1, graph.Node("stub:a.stub").Metric("ca")); // b links to a
        graph.AssertEdge("stub:b.stub", "links", "stub:a.stub");
        Assert.DoesNotContain(graph.Nodes, n => n.Id == "other:intruder");
        Assert.Null(graph.Node("stub:outside").Location);
        Assert.Null(graph.Node("stub:outside").Level);
        Assert.Null(graph.Node("stub:outside").Parent);
        Assert.DoesNotContain(graph.Edges, e => e.Target == "stub:nowhere");
        Assert.Contains("stub warning", graph.Analysis.Warnings);
        Assert.Contains(graph.Analysis.Warnings, w => w.StartsWith("Stub: dropped or fixed") && w.Contains("ids outside 'stub:'") && w.Contains("edges to nodes that do not exist"));
        Assert.Contains("stub:part", graph.Analysis.UnusedCandidates); // the manifest's rules for unused code

        var language = Assert.Single(graph.Source.Languages!);
        Assert.Equal(("stub", "Stub", "Items", "outside"), (language.Id, language.Name, language.Levels.Type[1], language.External));
        Assert.Equal("stub", graph.Node("stub:project").Language);
    }

    [NodeFact]
    public void A_plugin_takes_files_it_names_and_folders_with_its_project_files()
    {
        using var ws = new TestWorkspace().File("x/stub.json", "{}").File("x/a.stub", "").File("y/loose.stub", "").File("z/skipped/stub.json", "").File("z/skipped/b.stub", "");
        var (_, stub) = Stub();

        Assert.True(stub.CanAnalyzeFile(Path.Combine(ws.Root, "y/loose.stub")));
        Assert.False(stub.CanAnalyzeFile(Path.Combine(ws.Root, "x/stub.json")));
        Assert.True(stub.Detect(ws.Root, CancellationToken.None));
        Assert.True(stub.Detect(Path.Combine(ws.Root, "x"), CancellationToken.None));
        Assert.False(stub.Detect(Path.Combine(ws.Root, "y"), CancellationToken.None)); // sources without a project file
        Assert.False(stub.Detect(Path.Combine(ws.Root, "z"), CancellationToken.None)); // only in an ignored folder
    }

    [NodeFact]
    public void A_failing_plugin_says_why()
    {
        using var ws = new TestWorkspace().File("stub.json", "{}").File("fail.stub", "");
        var (registry, _) = Stub();

        var error = Assert.Throws<InvalidOperationException>(() => CodeMapAnalyzer.Analyze(ws.Root, registry, NoGit));

        Assert.Contains("Stub analysis failed (exit code 3)", error.Message);
        Assert.Contains("boom: fail.stub says so", error.Message);
    }

    [NodeFact]
    public void A_plugin_that_hangs_is_stopped()
    {
        using var ws = new TestWorkspace().File("stub.json", "{}").File("slow.stub", "");
        var (_, stub) = Stub();
        stub.Timeout = TimeSpan.FromSeconds(2);
        var started = System.Diagnostics.Stopwatch.StartNew();

        Assert.Throws<TimeoutException>(() => stub.Analyze(ws.Root, NoGit, CancellationToken.None));

        stub.Timeout = null;
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        Assert.ThrowsAny<OperationCanceledException>(() => stub.Analyze(ws.Root, NoGit, cancel.Token));
        Assert.True(started.Elapsed < TimeSpan.FromSeconds(30), $"took {started.Elapsed}");
    }

    [NodeFact]
    public void Without_its_runtime_a_plugin_cannot_run_and_other_languages_still_map()
    {
        using var ws = new TestWorkspace()
            .Project("Lib")
            .File("Lib/A.cs", "namespace Lib; public class A { }")
            .File("stub.json", "{}").File("a.stub", "");
        Environment.SetEnvironmentVariable("CODEMAP_TEST_NODE", Path.Combine(ws.Root, "no-such-node"));
        try
        {
            var (registry, _) = Stub();
            var graph = CodeMapAnalyzer.Analyze(ws.Root, registry, NoGit);

            graph.Node("T:Lib.A");
            Assert.Contains(graph.Analysis.Warnings, w => w.StartsWith("Stub was not analyzed: CODEMAP_TEST_NODE points to") && w.Contains("Install Node.js."));
            var only = Assert.Throws<InvalidOperationException>(() => CodeMapAnalyzer.Analyze(Path.Combine(ws.Root, "a.stub"), registry, NoGit));
            Assert.Contains("CODEMAP_TEST_NODE", only.Message);
        }
        finally
        {
            Environment.SetEnvironmentVariable("CODEMAP_TEST_NODE", null);
        }
    }

    [NodeFact]
    public void Csharp_and_a_plugin_in_one_folder_make_one_map()
    {
        using var ws = new TestWorkspace()
            .Project("Lib")
            .File("Lib/A.cs", "namespace Lib; public class A { }")
            .File("web/stub.json", "{}").File("web/a.stub", "");
        var (registry, _) = Stub();

        var graph = CodeMapAnalyzer.Analyze(ws.Root, registry, NoGit);

        Assert.Equal(new[] { "csharp", "stub" }, graph.Source.Languages!.Select(l => l.Id));
        Assert.Equal("web/a.stub", graph.Node("stub:a.stub").Location!.File);
        Assert.Equal("Lib/A.cs", graph.Node("T:Lib.A").Location!.File);
        Assert.Equal(("csharp", "stub"), (graph.Node("project:Lib").Language, graph.Node("stub:project").Language));
    }

    [Fact]
    public void Manifests_are_checked()
    {
        using var ws = new TestWorkspace()
            .File("good/codemap-plugin.json", Manifest("good", "good:"))
            .File("reserved/codemap-plugin.json", Manifest("reserved", "project:"))
            .File("short/codemap-plugin.json", Manifest("short", "s:"))
            .File("future/codemap-plugin.json", Manifest("future", "future:", protocol: 2))
            .File("same-prefix/codemap-plugin.json", Manifest("other", "good:"))
            .File("broken/codemap-plugin.json", "{ not json");

        var found = PluginCatalog.Discover(new[] { ws.Root });

        Assert.Equal(new[] { "good" }, found.Plugins.Select(p => p.Id));
        Assert.Equal(5, found.Problems.Count);
        Assert.Contains(found.Problems, p => p.Contains("idPrefix 'project:' is reserved"));
        Assert.Contains(found.Problems, p => p.Contains("protocol 2 is not supported"));
        Assert.Contains(found.Problems, p => p.Contains("already used by plugin 'good'"));
        Assert.Contains(found.Problems, p => p.Contains("not valid JSON"));

        // A plugin may not take C#'s id: the built-in language wins.
        var registry = new LanguageRegistry(new ILanguageAnalyzer[] { new Languages.CSharp.CSharpAnalyzer(), new ExternalProcessAnalyzer(PluginManifest.Load(Path.Combine(ws.Root, "good", "codemap-plugin.json"))) });
        Assert.Throws<ArgumentException>(() => registry.Only(new[] { "cobol" }));
        Assert.Equal(new[] { "good" }, registry.Only(new[] { "good" }).Languages.Select(l => l.Info.Id));
    }

    private static string Manifest(string id, string prefix, int protocol = 1) => $$"""
        { "protocol": {{protocol}}, "id": "{{id}}", "idPrefix": "{{prefix}}", "name": "{{id}}", "command": ["node", "./x.mjs"],
          "detect": { "markers": ["x.json"], "sources": [".x"], "inputs": ["*.x"] } }
        """;

    [NodeFact(typescript: true)]
    public void The_typescript_plugin_maps_a_package()
    {
        var registry = LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") });
        var fixture = Path.Combine(GoldenTests.RepoRoot(), "analyzers", "typescript", "test", "fixtures", "basic");

        var graph = CodeMapAnalyzer.Analyze(fixture, registry, NoGit);

        const string service = "ts:basic:src/orders/orders.service.ts";
        Assert.Equal(NodeLevels.Type, NodeLevels.Of(graph.Node(service)));
        Assert.Equal(NodeLevels.Member, NodeLevels.Of(graph.Node(service + "#OrdersService.place")));
        graph.AssertEdge(service + "#OrdersService.place", EdgeKinds.Calls, "ts:basic:src/orders/orders.repository.ts#OrdersRepository.save");
        graph.AssertEdge("ts:basic:src/main.ts", EdgeKinds.Imports, "ts:basic:src/index.ts");
        Assert.Equal(new[] { "ts:basic:src/domain/order.ts#unusedHelper" }, graph.Analysis.UnusedCandidates);
        Assert.True(graph.Node(service).Metric("ca") > 0);
        Assert.Equal("typescript", graph.Node("ts:project:basic").Language);
        Assert.Equal(new[] { "File", "Files" }, graph.Source.Languages![0].Levels.Type);
        Assert.Equal("src/orders/orders.service.ts", graph.Node(service).Location!.File);
    }
}
