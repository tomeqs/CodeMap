using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>
/// What the shared steps add to a graph, so that a finished map can be taken back to its raw graph
/// (<see cref="RawGraph.FromDerived"/>). Steps that only add a value when it is positive (<c>noc</c>, <c>methods</c>…)
/// would otherwise leave old values behind.
/// </summary>
internal static class DerivedState
{
    /// <summary>Tags only the shared steps give: cycles, unused code, hotspots, DI lifetimes and issues.</summary>
    public static readonly IReadOnlySet<string> Tags = new HashSet<string>(StringComparer.Ordinal)
    {
        Model.Tags.InCycle, Model.Tags.Unused, Model.Tags.Hotspot, Model.Tags.DiIssue,
        Model.Tags.DiSingleton, Model.Tags.DiScoped, Model.Tags.DiTransient,
    };

    /// <summary>Metrics of the git step (types).</summary>
    public static readonly IReadOnlySet<string> GitMetrics = new HashSet<string>(StringComparer.Ordinal) { "commits", "churn", "authors", "ageDays", "hotspot" };

    /// <summary>Sizes a type, or a member holding members, gets from its members.</summary>
    private static readonly string[] SizeMetrics = { "members", "methods", "constructors", "properties", "fields", "events", "complexity", "maxComplexity" };

    private static readonly HashSet<string> TypeMetrics = new(SizeMetrics.Concat(new[] { "ce", "ca", "instability", "noc" }).Concat(GitMetrics), StringComparer.Ordinal);
    private static readonly HashSet<string> OwnerMetrics = new(SizeMetrics.Concat(new[] { "fanIn", "fanOut" }), StringComparer.Ordinal);
    private static readonly HashSet<string> LeafMemberMetrics = new(StringComparer.Ordinal) { "fanIn", "fanOut" };
    private static readonly HashSet<string> ContainerMetrics = new(StringComparer.Ordinal) { "types", "loc", "complexity", "ce", "ca", "abstractness", "instability", "distance" };

    /// <summary>Removes in place what the shared steps added; the language's own data stays.</summary>
    public static void Strip(CodeGraph graph)
    {
        graph.Edges.RemoveAll(e => e.Kind == EdgeKinds.ChangesWith);
        graph.Stats = new Dictionary<string, int>();
        graph.Source.Git = null;

        var analysis = graph.Analysis;
        analysis.Cycles.Clear();
        analysis.Hotspots.Clear();
        analysis.MostComplex.Clear();
        analysis.MostDepended.Clear();
        analysis.UnusedCandidates.Clear();
        analysis.Layers.Clear();
        analysis.ChangeCoupling.Clear();
        analysis.Warnings.RemoveAll(GitEnrichment.IsGitWarning);
        analysis.Di = RawDi(analysis.Di);

        var owners = graph.Nodes.Where(NodeLevels.IsMember).Where(n => n.Parent != null).Select(n => n.Parent!).ToHashSet(StringComparer.Ordinal);
        foreach (var node in graph.Nodes)
        {
            if (node.Tags is { Count: > 0 } tags && tags.RemoveAll(Tags.Contains) > 0 && tags.Count == 0) node.Tags = null;

            var derived = NodeLevels.Of(node) switch
            {
                NodeLevels.Type => TypeMetrics,
                NodeLevels.Member => owners.Contains(node.Id) ? OwnerMetrics : LeafMemberMetrics,
                _ => ContainerMetrics,
            };
            if (node.Metrics is { Count: > 0 } metrics)
            {
                foreach (var name in metrics.Keys.Where(derived.Contains).ToList()) metrics.Remove(name);
                if (metrics.Count == 0) node.Metrics = null;
            }
        }
    }

    /// <summary>
    /// The DI setup as the languages give it: registrations, and what each consumer asks for. A finished map only
    /// keeps the dependencies of types the container builds, which are all the derivation looks at.
    /// </summary>
    private static DiAnalysis? RawDi(DiAnalysis? di)
    {
        if (di == null) return null;
        foreach (var registration in di.Registrations) registration.Effective = null;
        return new DiAnalysis
        {
            Registrations = di.Registrations,
            Dependencies = di.Dependencies.Select(d => new DiDependency
            {
                Consumer = d.Consumer,
                Service = d.Service,
                External = d.External,
                TypeArguments = d.TypeArguments,
                Many = d.Many,
                Optional = d.Optional,
                Key = d.Key,
                Framework = d.Framework,
            }).ToList(),
        };
    }
}
