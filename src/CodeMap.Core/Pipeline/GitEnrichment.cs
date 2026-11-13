using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>Churn, authors and age of every type from the git history, then hotspots and change coupling.</summary>
internal static class GitEnrichment
{
    private const string ShallowWarning = "The repository is a shallow clone";

    /// <summary>The history of the repository the graph's root is in; null when there is none or it is empty.</summary>
    public static GitHistory? Read(CodeGraph graph, AnalyzerOptions options, Action<string> log)
    {
        var history = GitHistory.Read(graph.Source.Root, options.GitSince, options.GitMaxCommits, log);
        return history is { CommitCount: > 0 } ? history : null;
    }

    public static void Apply(CodeGraph graph, GitHistory history, AnalyzerOptions options)
    {
        ApplyChurn(graph, history);
        GraphMetrics.ComputeHotspots(graph);
        ChangeCouplingAnalysis.Compute(graph, history);
        Finish(graph, new GitInfo { Branch = history.Branch, Commit = history.Head, CommitsAnalyzed = history.CommitCount, Since = options.GitSince, Shallow = history.Shallow });
    }

    /// <summary>The same from git data taken from another map (a saved one, or the analysis a simulation started from).</summary>
    public static void Apply(CodeGraph graph, GitSnapshot snapshot)
    {
        if (snapshot.Git == null) return;
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        foreach (var (id, metrics) in snapshot.Metrics)
        {
            if (!byId.TryGetValue(id, out var node) || !NodeLevels.IsType(node) || node.External) continue;
            foreach (var (name, value) in metrics) node.SetMetric(name, value);
        }

        GraphMetrics.ComputeHotspots(graph);
        var pairs = snapshot.ChangeCoupling.Where(p => byId.ContainsKey(p.Source) && byId.ContainsKey(p.Target))
            .Select(p => new ChangeCouplingInfo { Source = p.Source, Target = p.Target, SharedCommits = p.SharedCommits, Strength = p.Strength })
            .ToList();
        ChangeCouplingAnalysis.Attach(graph, pairs);
        var git = snapshot.Git;
        Finish(graph, new GitInfo { Branch = git.Branch, Commit = git.Commit, CommitsAnalyzed = git.CommitsAnalyzed, Since = git.Since, Shallow = git.Shallow });
    }

    /// <summary>Warnings this step writes (taken out again when a map is turned back into its raw graph).</summary>
    public static bool IsGitWarning(string warning) => warning.StartsWith(ShallowWarning, StringComparison.Ordinal);

    private static void Finish(CodeGraph graph, GitInfo git)
    {
        graph.Source.Git = git;
        if (git.Shallow)
        {
            graph.Analysis.Warnings.Add($"{ShallowWarning} with only {git.CommitsAnalyzed} commit(s): churn, hotspots and change coupling see just these (git fetch --unshallow gives them the whole history).");
        }
    }

    private static void ApplyChurn(CodeGraph graph, GitHistory history)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        foreach (var node in graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && n.Location != null))
        {
            var files = new[] { node.Location! }.Concat(node.ExtraLocations ?? new List<SourceLocation>())
                .Select(l => GitHistory.Key(l.File))
                .Distinct(GitHistory.PathComparer);

            // Commits are counted once per type (one commit over 13 partial files is one), churn is the lines of all its files.
            var commits = new HashSet<int>();
            var churn = 0;
            long last = 0;
            var authors = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in files)
            {
                if (!history.Files.TryGetValue(file, out var stats)) continue;
                commits.UnionWith(stats.CommitIndexes);
                churn += stats.Churn;
                last = Math.Max(last, stats.LastCommitUnix);
                authors.UnionWith(stats.Authors);
            }

            if (commits.Count == 0) continue;
            node.SetMetric("commits", commits.Count);
            node.SetMetric("churn", churn);
            node.SetMetric("authors", authors.Count);
            node.SetMetric("ageDays", Math.Max(0, (now - last) / 86400));
        }
    }
}

/// <summary>The git data of a finished map: per-type churn metrics, change coupling and where it came from.</summary>
internal sealed class GitSnapshot
{
    private static readonly string[] Names = { "commits", "churn", "authors", "ageDays" };

    public GitInfo? Git { get; private init; }
    public Dictionary<string, List<(string Name, double Value)>> Metrics { get; } = new(StringComparer.Ordinal);
    public List<ChangeCouplingInfo> ChangeCoupling { get; private init; } = new();

    public static GitSnapshot Capture(CodeGraph graph)
    {
        var snapshot = new GitSnapshot
        {
            Git = graph.Source.Git,
            ChangeCoupling = graph.Analysis.ChangeCoupling.ToList(),
        };
        foreach (var node in graph.Nodes)
        {
            if (node.Metrics == null || !NodeLevels.IsType(node)) continue;
            var values = Names.Where(node.Metrics.ContainsKey).Select(n => (n, node.Metrics[n])).ToList();
            if (values.Count > 0) snapshot.Metrics[node.Id] = values;
        }

        return snapshot;
    }
}
