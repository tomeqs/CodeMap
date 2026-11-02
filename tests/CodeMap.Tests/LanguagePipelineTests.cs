using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Languages.CSharp;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>The language layer: another language gets the same shared analysis, and languages in one folder merge.</summary>
public class LanguagePipelineTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };

    [Fact]
    public void A_language_gets_the_shared_analysis()
    {
        using var ws = new TestWorkspace().File("src/a.fake", "");
        var graph = CodeMapAnalyzer.Analyze(ws.Root, new LanguageRegistry(new[] { new FakeLanguage() }), NoGit);

        var a = graph.Node(FakeLanguage.A);
        var b = graph.Node(FakeLanguage.B);
        Assert.Contains(graph.Analysis.Cycles, c => c.Level == "type" && c.Nodes.Order().SequenceEqual(new[] { FakeLanguage.A, FakeLanguage.B }));
        Assert.True(a.HasTag(Tags.InCycle) && b.HasTag(Tags.InCycle));
        Assert.Equal(1, a.Metric("ce"));
        Assert.Equal(1, a.Metric("ca"));
        Assert.Equal(2, a.Metric("members"));
        Assert.Equal(3, graph.Node("fake:ns:app/src").Metric("types"));

        // Unused by the fake language's own rules: private members and any type nothing points at.
        Assert.Equal(new[] { FakeLanguage.C, FakeLanguage.A + "#helper" }.Order(), graph.Analysis.UnusedCandidates.Order());

        // The container setup the language found is checked like C#'s.
        var issue = Assert.Single(graph.Analysis.Di!.Issues);
        Assert.Equal(("captive", FakeLanguage.A, FakeLanguage.B), (issue.Kind, issue.Consumer, issue.Service));
        Assert.True(a.HasTag("singleton") && b.HasTag("scoped") && a.HasTag(Tags.DiIssue));

        Assert.Equal(3, graph.Stats["types"]);
        Assert.Equal(2, graph.Stats["members"]);
        Assert.Contains("fake warning", graph.Analysis.Warnings);
        Assert.Equal(ws.Root, graph.Source.Root);
    }

    [Fact]
    public void A_typescript_shaped_map_gets_levels_sizes_and_labels()
    {
        var graph = GoldenTests.TsMini();
        const string service = "ts:api:src/orders/orders.service.ts";

        // Files are the units; classes and functions are their members, methods are members of the class.
        Assert.Equal(NodeLevels.Type, NodeLevels.Of(graph.Node(service)));
        Assert.Equal(NodeLevels.Member, NodeLevels.Of(graph.Node(service + "#OrdersService")));
        Assert.Equal(NodeLevels.Member, NodeLevels.Of(graph.Node(service + "#OrdersService.place")));

        // A file's size comes from the innermost declarations: the class' constructor and methods, the function, the interface.
        var file = graph.Node(service);
        Assert.Equal((5, 3, 8, 4), ((int)file.Metric("members"), (int)file.Metric("methods"), (int)file.Metric("complexity"), (int)file.Metric("maxComplexity")));
        var type = graph.Node(service + "#OrdersService");
        Assert.Equal((3, 7), ((int)type.Metric("members"), (int)type.Metric("complexity")));

        // A file that only declares interfaces and type aliases is abstract.
        Assert.Equal(0.333, graph.Node("ts:project:domain").Metric("abstractness"));

        Assert.Contains(graph.Analysis.Cycles, c => c.Level == "type" && c.Nodes.Contains(service) && c.Nodes.Contains("ts:api:src/orders/orders.repository.ts"));
        Assert.Equal(new[] { service + "#legacyTotal" }, graph.Analysis.UnusedCandidates);
        Assert.Equal("captive", Assert.Single(graph.Analysis.Di!.Issues).Kind);

        var language = Assert.Single(graph.Source.Languages!);
        Assert.Equal(("typescript", "File", "Files", "npm packages"), (language.Id, language.Levels.Type[0], language.Levels.Type[1], language.External));
        Assert.Equal("typescript", graph.Node("ts:project:api").Language);
        Assert.Equal("typescript", graph.Node("ts:npm:express").Language);
        Assert.Equal(9, graph.Stats["types"]);
    }

    [Fact]
    public void Languages_found_in_one_folder_are_merged_into_one_map()
    {
        using var ws = new TestWorkspace()
            .Project("Lib")
            .File("Lib/Clock.cs", "namespace Lib; public interface IClock { } public class Clock : IClock { }")
            .File("web/src/a.fake", "");
        var registry = new LanguageRegistry(new ILanguageAnalyzer[] { new CSharpAnalyzer(), new FakeLanguage(rootFolder: "web") });

        var graph = CodeMapAnalyzer.Analyze(ws.Root, registry, NoGit);

        Assert.Equal(("directory", Path.GetFullPath(ws.Root)), (graph.Source.Kind, graph.Source.Root));
        Assert.Equal(new[] { "fake:project:app", "project:Lib" }, graph.Nodes.Where(n => n.Kind == NodeKinds.Project).Select(n => n.Id)); // by id
        Assert.Equal("Lib/Clock.cs", graph.Node("T:Lib.Clock").Location!.File);
        Assert.Equal("web/src/a.fake", graph.Node(FakeLanguage.A).Location!.File); // relative to the merged root now
        graph.AssertEdge("T:Lib.Clock", EdgeKinds.Implements, "T:Lib.IClock");
        Assert.Equal(2, graph.Stats["projects"]);

        // Nodes keep the order of a single-language map: containers first, then types and members.
        var levels = graph.Nodes.Select(NodeLevels.Of).ToList();
        Assert.True(levels.LastIndexOf(NodeLevels.Project) < levels.IndexOf(NodeLevels.Namespace));
        Assert.True(levels.LastIndexOf(NodeLevels.Namespace) < levels.IndexOf(NodeLevels.Type));
    }

    [Fact]
    public void A_language_that_fails_in_a_mixed_folder_leaves_a_warning_and_the_rest_of_the_map()
    {
        using var ws = new TestWorkspace()
            .Project("Lib")
            .File("Lib/A.cs", "namespace Lib; public class A { }")
            .File("web/fail.fake", "");
        var registry = new LanguageRegistry(new ILanguageAnalyzer[] { new CSharpAnalyzer(), new FakeLanguage() });

        var graph = CodeMapAnalyzer.Analyze(ws.Root, registry, NoGit);

        graph.Node("T:Lib.A");
        Assert.Contains("Fake was not analyzed: broken", graph.Analysis.Warnings);

        // Alone, its error is the analysis' error.
        var error = Assert.Throws<InvalidOperationException>(() => CodeMapAnalyzer.Analyze(Path.Combine(ws.Root, "web"), registry, NoGit));
        Assert.Equal("broken", error.Message);
    }

    [Fact]
    public void Inputs_nobody_takes_are_explained()
    {
        using var ws = new TestWorkspace().File("notes.txt", "").File("empty/readme.md", "");
        var path = Path.Combine(ws.Root, "empty");

        Assert.Equal($"No .csproj or .cs files found in '{path}'.", Assert.Throws<ArgumentException>(() => ws.Analyze(path)).Message);
        Assert.Equal($"Unsupported input '{Path.Combine(ws.Root, "notes.txt")}'. Use a .sln, .slnx, .slnf, .csproj, .cs file or a directory.",
            Assert.Throws<ArgumentException>(() => ws.Analyze(Path.Combine(ws.Root, "notes.txt"))).Message);
        Assert.Throws<FileNotFoundException>(() => ws.Analyze(Path.Combine(ws.Root, "missing")));

        var both = new LanguageRegistry(new ILanguageAnalyzer[] { new CSharpAnalyzer(), new FakeLanguage() });
        Assert.Equal($"No .csproj or .cs files or .fake files found in '{path}'.",
            Assert.Throws<ArgumentException>(() => CodeMapAnalyzer.Analyze(path, both, NoGit)).Message);
    }

    [Fact]
    public void Dependency_injection_is_worked_out_from_plain_data()
    {
        GraphNode Type(string id) => new() { Id = id, Kind = NodeKinds.Class, Name = id, Project = "p" };
        var graph = new CodeGraph { Nodes = { Type("Consumer"), Type("P1"), Type("P2"), Type("Clock"), Type("Clock2") } };
        graph.Analysis.Di = new DiAnalysis
        {
            Registrations =
            {
                new ServiceRegistration { Service = "Consumer", Lifetime = "singleton" },
                new ServiceRegistration { Service = "IPlugin", Implementation = "P1", Lifetime = "transient" },
                new ServiceRegistration { Service = "IPlugin", Implementation = "P2", Lifetime = "scoped" },
                new ServiceRegistration { Service = "IClock", Implementation = "Clock", Lifetime = "singleton" },
                new ServiceRegistration { Service = "IClock", Implementation = "Clock2", Lifetime = "singleton" },
            },
            Dependencies =
            {
                new DiDependency { Consumer = "Consumer", Service = "IPlugin", Many = true },
                new DiDependency { Consumer = "Consumer", Service = "IClock" },
                new DiDependency { Consumer = "Consumer", Service = "IMissing" },
                new DiDependency { Consumer = "Consumer", Service = "IOptional", Optional = true },
                new DiDependency { Consumer = "Consumer", Service = "Microsoft.Extensions.Options.IOptionsSnapshot<TOptions>", External = true },
                new DiDependency { Consumer = "NotBuiltByTheContainer", Service = "IMissing" },
            },
        };

        DependencyInjectionAnalysis.Compute(graph);

        var di = graph.Analysis.Di!;
        var dependencies = di.Dependencies.ToDictionary(d => d.Service);
        Assert.Equal(5, di.Dependencies.Count);
        Assert.Equal(new[] { "P1", "P2" }, dependencies["IPlugin"].Implementations);
        Assert.Equal("mixed", dependencies["IPlugin"].Lifetime);
        Assert.Equal(new[] { "Clock2" }, dependencies["IClock"].Implementations); // the last registration wins
        Assert.Equal("singleton", dependencies["IClock"].ConsumerLifetime);
        Assert.Equal("scoped", dependencies["Microsoft.Extensions.Options.IOptionsSnapshot<TOptions>"].Lifetime);
        Assert.Equal(
            new[] { ("captive", "IPlugin"), ("captive", "Microsoft.Extensions.Options.IOptionsSnapshot<TOptions>"), ("unregistered", "IMissing") },
            di.Issues.Select(i => (i.Kind, i.Service)).OrderBy(i => i.Kind).ThenBy(i => i.Service, StringComparer.Ordinal));
    }

    [Fact]
    public void Without_registrations_or_framework_types_there_is_no_container_analysis()
    {
        var graph = new CodeGraph { Nodes = { new GraphNode { Id = "A", Kind = NodeKinds.Class, Name = "A" } } };
        graph.Analysis.Di = new DiAnalysis { Dependencies = { new DiDependency { Consumer = "A", Service = "B" } } };

        DependencyInjectionAnalysis.Compute(graph);

        Assert.Null(graph.Analysis.Di);
    }

    /// <summary>
    /// A made-up language: every folder with *.fake files is one project "app" with three files (a, b, c) in
    /// src/; a and b depend on each other, c is unused, and the container holds a singleton a that needs a scoped b.
    /// </summary>
    private sealed class FakeLanguage(string? rootFolder = null) : ILanguageAnalyzer
    {
        public const string A = "fake:app:src/a.fake";
        public const string B = "fake:app:src/b.fake";
        public const string C = "fake:app:src/c.fake";

        public LanguageInfo Info { get; } = new()
        {
            Id = "fake",
            Name = "Fake",
            Inputs = "a .fake file",
            Markers = ".fake files",
            Unused = new UnusedPolicy { MemberAccessibility = new HashSet<string> { "private" } },
        };

        public bool CanAnalyzeFile(string path) => path.EndsWith(".fake", StringComparison.Ordinal);

        public bool Detect(string directory, CancellationToken ct) =>
            Directory.EnumerateFiles(directory, "*.fake", SearchOption.AllDirectories).Any();

        public CodeGraph Analyze(string path, AnalyzerOptions options, CancellationToken ct)
        {
            var full = Path.GetFullPath(path);
            if (Directory.EnumerateFiles(full, "fail.fake", SearchOption.AllDirectories).Any()) throw new InvalidOperationException("broken");

            var graph = new CodeGraph();
            graph.Source.Path = full;
            graph.Source.Root = rootFolder == null ? full : Path.Combine(full, rootFolder);
            graph.Source.Kind = "directory";
            graph.Source.Name = "app";

            const string project = "fake:project:app";
            const string ns = "fake:ns:app/src";
            graph.Nodes.Add(new GraphNode { Id = project, Kind = NodeKinds.Project, Name = "app", Project = project });
            graph.Nodes.Add(new GraphNode { Id = ns, Kind = NodeKinds.Namespace, Name = "src", Parent = project, Project = project });
            foreach (var id in new[] { A, B, C })
            {
                var file = id.Split(':')[^1];
                graph.Nodes.Add(new GraphNode
                {
                    Id = id, Kind = "module", Name = Path.GetFileName(file), Parent = ns, Project = project, Accessibility = "public",
                    Location = new SourceLocation { File = file, Line = 1, EndLine = 10 },
                    Metrics = new Dictionary<string, double> { ["loc"] = 10 },
                });
            }

            graph.Nodes.Add(new GraphNode { Id = A + "#run", Kind = NodeKinds.Method, Name = "run", Parent = A, Project = project, Accessibility = "public" });
            graph.Nodes.Add(new GraphNode { Id = A + "#helper", Kind = NodeKinds.Method, Name = "helper", Parent = A, Project = project, Accessibility = "private" });
            graph.Edges.Add(new GraphEdge { Source = A + "#run", Target = B, Kind = EdgeKinds.Uses });
            graph.Edges.Add(new GraphEdge { Source = B, Target = A, Kind = EdgeKinds.Uses });

            graph.Analysis.Warnings.Add("fake warning");
            graph.Analysis.Di = new DiAnalysis
            {
                Registrations =
                {
                    new ServiceRegistration { Service = A, Lifetime = "singleton" },
                    new ServiceRegistration { Service = B, Lifetime = "scoped" },
                },
                Dependencies = { new DiDependency { Consumer = A, Service = B } },
            };
            return graph;
        }
    }
}
