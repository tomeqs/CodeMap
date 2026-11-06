using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>
/// The graph as the languages read it, before the steps that are the same for every language (metrics, cycles,
/// unused code, layers, DI, git, counts), with what those steps need. <see cref="GraphPipeline.Derive"/> turns it
/// into a finished map as often as needed: after a change to the graph (a what-if simulation) or to the options.
/// </summary>
/// <remarks>Treat <see cref="Graph"/> as read-only: <see cref="GraphPipeline.Derive"/> works on a copy, and a changed
/// graph goes in through <see cref="With"/>.</remarks>
public sealed class RawGraph
{
    internal RawGraph(CodeGraph graph, IReadOnlyDictionary<string, LanguageInfo> languageOfProject, AnalyzerOptions options,
        GitHistory? history, GitSnapshot? carriedGit)
    {
        Graph = graph;
        LanguageOfProject = languageOfProject;
        Options = options;
        History = history;
        CarriedGit = carriedGit;
    }

    public CodeGraph Graph { get; }

    /// <summary>Language of every project node, by its id: decides which nodes may be unused and which DI conventions apply.</summary>
    public IReadOnlyDictionary<string, LanguageInfo> LanguageOfProject { get; }

    public AnalyzerOptions Options { get; }

    /// <summary>The git history, read once; null without git (no repository, <c>--no-git</c>) or for a saved map.</summary>
    public GitHistory? History { get; }

    /// <summary>The git data of a saved map (<see cref="FromDerived"/>), put back by node id when it is derived again.</summary>
    internal GitSnapshot? CarriedGit { get; }

    /// <summary>The same languages, options and history for another graph (a changed copy of <see cref="Graph"/>).</summary>
    public RawGraph With(CodeGraph graph) => new(graph, LanguageOfProject, Options, History, CarriedGit);

    /// <summary>The language of a node, by its project.</summary>
    public LanguageInfo? LanguageOf(GraphNode node) =>
        node.Project != null && LanguageOfProject.TryGetValue(node.Project, out var language) ? language : null;

    /// <summary>
    /// The raw graph behind a finished map (a <c>.codemap.json</c> file): a copy without what the shared steps added.
    /// Its git data is kept as it was saved and put back when the graph is derived again; the DI setup is reduced to
    /// the registrations and what the consumers ask for. Languages the registry does not know keep their nodes, but
    /// none of them is reported as unused.
    /// </summary>
    public static RawGraph FromDerived(CodeGraph derived, LanguageRegistry registry)
    {
        var graph = derived.Clone();
        var carried = GitSnapshot.Capture(graph);
        DerivedState.Strip(graph);

        var known = new Dictionary<string, LanguageInfo>(StringComparer.Ordinal);
        LanguageInfo LanguageFor(string? id)
        {
            id ??= "csharp"; // format 1.0 maps were C# only and have no language on their projects
            if (known.TryGetValue(id, out var info)) return info;
            var summary = derived.Source.Languages?.FirstOrDefault(l => l.Id == id);
            info = registry.Find(id)?.Info ?? new LanguageInfo
            {
                Id = id,
                Name = summary?.Name ?? id,
                Inputs = "",
                Markers = "",
                Levels = summary?.Levels ?? new LevelLabels(),
                External = summary?.External ?? "external",
            };
            return known[id] = info;
        }

        var languageOfProject = new Dictionary<string, LanguageInfo>(StringComparer.Ordinal);
        foreach (var project in graph.Nodes.Where(n => n.Kind == NodeKinds.Project)) languageOfProject[project.Id] = LanguageFor(project.Language);

        var options = new AnalyzerOptions { Git = derived.Source.Git != null, GitSince = derived.Source.Git?.Since };
        return new RawGraph(graph, languageOfProject, options, history: null, carried);
    }
}

/// <summary>The shared steps <see cref="GraphPipeline.Derive"/> runs, in this order.</summary>
[Flags]
public enum DeriveSteps
{
    None = 0,

    /// <summary>Sizes, complexity, coupling, abstractness, cycles, unused code, rankings.</summary>
    Metrics = 1,

    /// <summary>Layers of projects and namespaces, with the upward dependencies.</summary>
    Layers = 2,

    /// <summary>What the DI container injects, lifetimes, issues.</summary>
    Di = 4,

    /// <summary>Churn, authors, age, hotspots and change coupling from git.</summary>
    Git = 8,

    /// <summary>The counts in <see cref="CodeGraph.Stats"/>.</summary>
    Stats = 16,

    All = Metrics | Layers | Di | Git | Stats,
}

public sealed class DeriveOptions
{
    public DeriveSteps Steps { get; init; } = DeriveSteps.All;

    /// <summary>
    /// Take the git data from this finished map (by node id) instead of the history: faster when many graphs are
    /// derived from one analysis, e.g. what-if simulations of the same code.
    /// </summary>
    public CodeGraph? GitFrom { get; init; }
}
