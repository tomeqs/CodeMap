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

/// <summary>Runs only where a Python the Python plugin accepts (3.9+) is found; CI requires it.</summary>
public sealed class PythonFactAttribute : FactAttribute
{
    public PythonFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("CODEMAP_REQUIRE_PYTHON") == "1") return;
        var manifest = PluginManifest.Load(Path.Combine(GoldenTests.RepoRoot(), "analyzers", "python", PluginManifest.FileName));
        var (found, problem) = RuntimeLocator.Find(manifest.Runtime!);
        if (found == null) Skip = problem;
    }
}

/// <summary>Languages as separate programs: the stub plugin (tests/CodeMap.Tests/Plugins/stub) and the real TypeScript and Python ones.</summary>
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
        using var ws = new TestWorkspace().File("x/stub.json", "{}").File("x/a.stub", "").File("x/src/c.stub", "").File("y/loose.stub", "").File("z/skipped/stub.json", "").File("z/skipped/b.stub", "");
        var (_, stub) = Stub();

        Assert.True(stub.CanAnalyzeFile(Path.Combine(ws.Root, "y/loose.stub")));
        Assert.False(stub.CanAnalyzeFile(Path.Combine(ws.Root, "x/stub.json")));
        Assert.True(stub.Detect(ws.Root, CancellationToken.None));
        Assert.True(stub.Detect(Path.Combine(ws.Root, "x"), CancellationToken.None));
        Assert.True(stub.Detect(Path.Combine(ws.Root, "x", "src"), CancellationToken.None)); // its project file is above it
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
            .File("broken/codemap-plugin.json", "{ not json")
            .File("pattern/codemap-plugin.json", Manifest("pattern", "pattern:").Replace("\"detect\"", "\"unused\": { \"skipNamePattern\": \"(\" }, \"detect\""))
            .File("null-id/codemap-plugin.json", Manifest("x", "nullid:").Replace("\"id\": \"x\"", "\"id\": null"))
            .File("null-detect/codemap-plugin.json", """{ "protocol": 1, "id": "nodetect", "idPrefix": "nodetect:", "name": "n", "command": ["node"], "detect": null }""")
            .File("null-command/codemap-plugin.json", """{ "protocol": 1, "id": "nocommand", "idPrefix": "nocommand:", "name": "n", "command": [null], "detect": { "sources": [".x"] } }""");

        var found = PluginCatalog.Discover(new[] { ws.Root });

        Assert.Equal(new[] { "good" }, found.Plugins.Select(p => p.Id));
        Assert.Equal(9, found.Problems.Count);
        Assert.Contains(found.Problems, p => p.Contains("skipNamePattern is not a valid regular expression"));
        Assert.Contains(found.Problems, p => p.Contains("id '' must be lowercase"));
        Assert.Contains(found.Problems, p => p.Contains("detect is needed"));
        Assert.Contains(found.Problems, p => p.Contains("a command is needed"));

        // A broken plugin is one problem among others: C# and the good plugin still work.
        var withPlugins = LanguageRegistry.WithPlugins(new[] { ws.Root });
        Assert.Equal(new[] { "csharp", "good" }, withPlugins.Languages.Select(l => l.Info.Id));
        Assert.Equal(9, withPlugins.Problems.Count);
        Assert.Contains(found.Problems, p => p.Contains("idPrefix 'project:' is reserved"));
        Assert.Contains(found.Problems, p => p.Contains("protocol 2 is not supported"));
        Assert.Contains(found.Problems, p => p.Contains("already used by plugin 'good'"));
        Assert.Contains(found.Problems, p => p.Contains("not valid JSON"));

        // A plugin may not take C#'s id: the built-in language wins.
        var registry = new LanguageRegistry(new ILanguageAnalyzer[] { new Languages.CSharp.CSharpAnalyzer(), new ExternalProcessAnalyzer(PluginManifest.Load(Path.Combine(ws.Root, "good", "codemap-plugin.json"))) });
        Assert.Throws<ArgumentException>(() => registry.Only(new[] { "cobol" }));
        Assert.Equal(new[] { "good" }, registry.Only(new[] { "good" }).Languages.Select(l => l.Info.Id));
    }

    [Fact]
    public void Plugins_are_only_looked_for_in_absolute_folders()
    {
        var absolute = Path.Combine(Path.GetTempPath(), "codemap-plugins");
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        IEnumerable<string> Folders(string? path, string? home) =>
            PluginCatalog.DefaultFolders(name => name switch { "CODEMAP_PLUGIN_PATH" => path, "CODEMAP_HOME" => home, _ => null });

        // An empty CODEMAP_HOME is not set: ~/.codemap, not ./plugins of the current folder.
        var empty = Folders(null, "").ToList();
        Assert.All(empty, f => Assert.True(Path.IsPathFullyQualified(f), f));
        if (!string.IsNullOrEmpty(profile)) Assert.Contains(Path.Combine(profile, ".codemap", "plugins"), empty);
        Assert.Contains(Path.Combine(AppContext.BaseDirectory, "plugins"), empty);

        // Relative folders are left out, whichever variable names them.
        var relative = Folders($"plugins{Path.PathSeparator}{absolute}", Path.Combine("some", "home")).ToList();
        Assert.Contains(absolute, relative);
        Assert.DoesNotContain(relative, f => !Path.IsPathFullyQualified(f));
        Assert.DoesNotContain(Path.Combine("some", "home", "plugins"), relative);
    }

    [Fact]
    public void Diagnostics_from_a_plugin_are_checked()
    {
        using var ws = new TestWorkspace().File("good/codemap-plugin.json", Manifest("good", "good:"));
        var plugin = PluginManifest.Load(Path.Combine(ws.Root, "good", "codemap-plugin.json"));
        var graph = new CodeGraph();
        graph.Nodes.Add(new GraphNode { Id = "good:a", Kind = "module", Name = "a", Location = new SourceLocation { File = "a.x", Line = 1, EndLine = 9 } });
        CodeDiagnostic Diagnostic(string rule, string file, string? node = null, string severity = "warning") =>
            new() { Rule = rule, Severity = severity, Message = "m", Location = new SourceLocation { File = file, Line = 3 }, Node = node };
        graph.Analysis.Diagnostics = new List<CodeDiagnostic>
        {
            Diagnostic("ok", "a.x", "good:a"),
            Diagnostic("unknown-node", "a.x", "good:missing", severity: "fatal"),
            Diagnostic("", "a.x"),
            Diagnostic("outside", "../elsewhere.x"),
        };
        graph.Analysis.Diagnostics.AddRange(Enumerable.Range(0, CodeDiagnostics.MaxPerRule + 5).Select(_ => Diagnostic("many", "a.x")));

        FragmentValidator.Validate(graph, plugin, ws.Root);

        var kept = graph.Analysis.Diagnostics!;
        Assert.Equal("good:a", kept.Single(d => d.Rule == "ok").Node);
        var unknown = kept.Single(d => d.Rule == "unknown-node");
        Assert.Null(unknown.Node);
        Assert.Equal("warning", unknown.Severity);
        Assert.DoesNotContain(kept, d => d.Rule is "" or "outside");
        Assert.Equal(CodeDiagnostics.MaxPerRule, kept.Count(d => d.Rule == "many"));
        Assert.Contains(graph.Analysis.Warnings, w => w.Contains("2 diagnostics without a rule or a place in the root"));
    }

    [Fact]
    public void Parent_cycles_from_a_plugin_are_cut()
    {
        using var ws = new TestWorkspace().File("good/codemap-plugin.json", Manifest("good", "good:"));
        var plugin = PluginManifest.Load(Path.Combine(ws.Root, "good", "codemap-plugin.json"));
        var graph = new CodeGraph();
        graph.Nodes.AddRange(new[]
        {
            new GraphNode { Id = "good:root", Kind = "project", Name = "root" },
            new GraphNode { Id = "good:self", Kind = "item", Name = "self", Parent = "good:self" },
            new GraphNode { Id = "good:a", Kind = "item", Name = "a", Parent = "good:b" },
            new GraphNode { Id = "good:b", Kind = "item", Name = "b", Parent = "good:a" },
            new GraphNode { Id = "good:leaf", Kind = "item", Name = "leaf", Parent = "good:a" },
            new GraphNode { Id = "good:fine", Kind = "item", Name = "fine", Parent = "good:root" },
        });

        FragmentValidator.Validate(graph, plugin, ws.Root);

        var byId = graph.Nodes.ToDictionary(n => n.Id);
        foreach (var node in graph.Nodes)
        {
            var seen = new HashSet<string>();
            for (var current = node; current.Parent != null; current = byId[current.Parent]) Assert.True(seen.Add(current.Id), $"{node.Id} is its own ancestor");
        }

        Assert.Null(byId["good:self"].Parent);
        Assert.Equal("good:root", byId["good:fine"].Parent);
        Assert.Equal(1, new[] { byId["good:a"].Parent, byId["good:b"].Parent }.Count(p => p == null)); // the cycle is cut once
        Assert.Contains(graph.Analysis.Warnings, w => w.Contains("2 parent cycles"));
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

        // A folder inside the package maps with the package's ids, and locations relative to the folder.
        var orders = CodeMapAnalyzer.Analyze(Path.Combine(fixture, "src", "orders"), registry, NoGit);
        Assert.Equal("orders.service.ts", orders.Node(service).Location!.File);
        Assert.Equal("ts:project:basic", Assert.Single(orders.Nodes, n => n.Kind == NodeKinds.Project).Id);
    }

    internal static string PythonFixture(string name) => Path.Combine(GoldenTests.RepoRoot(), "analyzers", "python", "test", "fixtures", name);

    [PythonFact]
    public void The_python_plugin_maps_a_project()
    {
        var registry = LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") });
        var fixture = PythonFixture("mini");
        Assert.True(registry.Find("python")!.Detect(fixture, CancellationToken.None));

        var graph = CodeMapAnalyzer.Analyze(fixture, registry, NoGit);

        const string service = "py:mini:src/mini/orders/service.py";
        Assert.Equal(NodeLevels.Type, NodeLevels.Of(graph.Node(service)));
        Assert.Equal(NodeLevels.Member, NodeLevels.Of(graph.Node(service + "#OrderService.place")));
        graph.AssertEdge(service + "#OrderService.place", EdgeKinds.Calls, "py:mini:src/mini/orders/ports.py#Repository.save");
        graph.AssertEdge(service + "#MemoryRepository.save", EdgeKinds.Implements, "py:mini:src/mini/orders/ports.py#Repository.save");
        graph.AssertEdge("py:mini:src/mini/cli.py", EdgeKinds.Imports, "py:mini:src/mini/__init__.py");
        graph.AssertEdge("py:project:mini", EdgeKinds.PackageReference, "py:pypi:requests");
        Assert.Equal(new[] { service + "#OrderService._forgotten" }, graph.Analysis.UnusedCandidates);
        Assert.Contains("entrypoint", graph.Node("py:mini:src/mini/cli.py#main").Tags!);
        Assert.Equal("python", graph.Node("py:project:mini").Language);
        Assert.Equal(new[] { "Module", "Modules" }, graph.Source.Languages![0].Levels.Type);
        Assert.Equal("src/mini/orders/service.py", graph.Node(service).Location!.File);
        Assert.Equal("mini.orders.service.OrderService.place", graph.Node(service + "#OrderService.place").FullName);
        Assert.Equal("interface", graph.Node("py:mini:src/mini/orders/ports.py#Repository").Kind);
        Assert.True(graph.Node(service).Metric("ca") > 0);

        // A package inside the project maps with the project's ids, and locations relative to the package.
        var orders = CodeMapAnalyzer.Analyze(Path.Combine(fixture, "src", "mini", "orders"), registry, NoGit);
        Assert.Equal("service.py", orders.Node(service).Location!.File);
        Assert.Equal("py:project:mini", Assert.Single(orders.Nodes, n => n.Kind == NodeKinds.Project).Id);
    }

    [PythonFact]
    public void Fastapi_routes_start_call_flows_and_depends_is_the_di_view()
    {
        var registry = LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") });
        var graph = CodeMapAnalyzer.Analyze(PythonFixture("fastapi"), registry, NoGit);
        const string orders = "py:shop-api:app/api/orders.py#", deps = "py:shop-api:app/deps.py#";

        // The container: FastAPI's rules on what the plugin found.
        var di = graph.Analysis.Di!;
        var issue = Assert.Single(di.Issues);
        Assert.Equal(("captive", "error", deps + "get_report_cache", deps + "get_db"), (issue.Kind, issue.Severity, issue.Consumer, issue.Service));
        Assert.Contains("get_report_cache is cached for the whole application but depends on the per-request get_db", issue.Message);
        var service = di.Dependencies.Single(d => d.Consumer == orders + "OrderService" && d.Service == deps + "get_db");
        Assert.Equal(("scoped", "scoped", "fastapi"), (service.ConsumerLifetime, service.Lifetime, service.Framework));
        Assert.Contains("di-issue", graph.Node(deps + "get_report_cache").Tags!);
        Assert.Contains("singleton", graph.Node(deps + "get_settings").Tags!);

        // Routes are where flows start, with their full paths.
        Assert.Equal("POST /api/orders/{order_id}/pay", graph.Node(orders + "pay_order").Doc);
        var flows = new CodeMap.Insights.CallFlow(new CodeMap.Insights.GraphIndex(graph));
        var entry = Assert.Single(flows.FindEntryPoints(), e => e.Node.Id == "py:shop-api:app/api/orders.py");
        Assert.Equal("controller", entry.Role);
        var flow = flows.Build(new[] { orders + "pay_order" });
        Assert.Contains(flow.Methods, m => m.Id == "py:shop-api:app/models.py#Order.pay");
        Assert.Contains("entity", graph.Node("py:shop-api:app/models.py#Order").Tags!);
        graph.AssertEdge("py:shop-api:app/models.py#Customer.orders", EdgeKinds.Holds, "py:shop-api:app/models.py#Order");
    }

    [PythonFact]
    public void A_python_script_in_a_csharp_repository_does_not_make_it_a_python_one()
    {
        using var ws = new TestWorkspace()
            .File("App.sln", "")
            .File("src/App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
            .File("scripts/bump_version.py", "print(1)\n")
            .File("tools/report.py", "print(2)\n");
        var python = LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") }).Find("python")!;

        Assert.False(python.Detect(ws.Root, CancellationToken.None));
        Assert.True(python.Detect(Path.Combine(ws.Root, "scripts"), CancellationToken.None)); // a folder of scripts on its own
    }

    [NodeFact(typescript: true)]
    public void Nest_and_angular_containers_get_their_own_rules()
    {
        var registry = LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") });
        string Fixture(string name) => Path.Combine(GoldenTests.RepoRoot(), "analyzers", "typescript", "test", "fixtures", name);

        var nest = CodeMapAnalyzer.Analyze(Fixture("nest"), registry, NoGit).Analysis.Di!;
        const string o = "ts:shop-api:src/orders/";
        Assert.Equal(
            new[]
            {
                ("interface-injection", o + "orders.service.ts#OrdersService", o + "pricing.ts#Pricing"),
                ("scope-bubbling", o + "orders.controller.ts#OrdersController", o + "orders.service.ts#OrdersService"),
                ("scope-bubbling", o + "orders.service.ts#OrdersService", o + "request-context.ts#RequestContext"),
            },
            nest.Issues.Select(i => (i.Kind, i.Consumer, i.Service)));
        Assert.Equal("scoped", nest.Registrations.Single(r => r.Service == o + "orders.controller.ts#OrdersController").Effective);
        Assert.Equal(new[] { o + "orders.repository.ts#SqlOrdersRepository" },
            nest.Dependencies.Single(d => d.Service == o + "orders.repository.ts#ORDERS_REPOSITORY").Implementations);

        var angular = CodeMapAnalyzer.Analyze(Fixture("angular"), registry, NoGit).Analysis.Di!;
        var issue = Assert.Single(angular.Issues);
        Assert.Equal(("unreachable", "error", "ts:shop-web:src/app/orders.store.ts#OrdersStore"), (issue.Kind, issue.Severity, issue.Consumer));
    }
}
