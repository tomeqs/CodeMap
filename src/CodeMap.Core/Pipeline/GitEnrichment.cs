using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>Churn, authors and age of every type from the git history, then hotspots and change coupling.</summary>
internal static class GitEnrichment
{
    public static void Apply(CodeGraph graph, AnalyzerOptions options, Action<string> log)
    {
        var root = graph.Source.Root;
        var history = GitHistory.Read(root, options.GitSince, options.GitMaxCommits, log);
        if (history is not { CommitCount: > 0 }) return;

        ApplyChurn(graph, history, root);
        GraphMetrics.ComputeHotspots(graph);
        ChangeCouplingAnalysis.Compute(graph, history, root);
        graph.Source.Git = new GitInfo { Branch = history.Branch, Commit = history.Head, CommitsAnalyzed = history.CommitCount, Since = options.GitSince, Shallow = history.Shallow };
        if (history.Shallow)
        {
            graph.Analysis.Warnings.Add($"The repository is a shallow clone with only {history.CommitCount} commit(s): churn, hotspots and change coupling see just these (git fetch --unshallow gives them the whole history).");
        }
    }

    private static void ApplyChurn(CodeGraph graph, GitHistory history, string root)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        foreach (var node in graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && n.Location != null))
        {
            var files = new[] { node.Location! }.Concat(node.ExtraLocations ?? new List<SourceLocation>())
                .Select(l => Path.GetFullPath(Path.Combine(root, l.File)))
                .Distinct(StringComparer.Ordinal);

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
