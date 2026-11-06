using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>What changed between two maps of the same code, in the terms of the second map's ids.</summary>
public sealed class GraphDiffReport
{
    public required DiffScore Score { get; init; }
    public required DiffCounts Counts { get; init; }
    public required DiffNodes Nodes { get; init; }

    /// <summary>The level dependencies, layers and metrics are compared at.</summary>
    public required string Level { get; init; }

    public required DiffDependencies Dependencies { get; init; }
    public required List<DiffCycles> Cycles { get; init; }
    public required DiffEdges Upward { get; init; }
    public required DiffFindings Findings { get; init; }
    public required List<DiffMetric> Metrics { get; init; }

    /// <summary>A few lines of the most important changes.</summary>
    public required List<string> Summary { get; init; }
}

public sealed record DiffScore(int Before, int After, int Delta, string GradeBefore, string GradeAfter, List<DiffScorePart> Parts);

public sealed record DiffScorePart(string Name, double Before, double After, double Delta);

/// <summary>Sizes before and after: types, members, edges, cycles, findings.</summary>
public sealed record DiffCounts(Dictionary<string, int> Before, Dictionary<string, int> After);

public sealed record DiffNodes(List<string> Added, List<string> Removed, List<DiffMove> Moved, List<DiffMove> Renamed, int AddedTotal, int RemovedTotal);

public sealed record DiffMove(string Before, string After, string? FromContainer, string? ToContainer);

public sealed record DiffDependency(string Source, string Target, int Before, int After);

public sealed record DiffDependencies(List<DiffDependency> Added, List<DiffDependency> Removed, List<DiffDependency> Changed, int AddedTotal, int RemovedTotal, int ChangedTotal);

public sealed record DiffCycle(List<string> Nodes, int SizeBefore, int SizeAfter);

public sealed record DiffCycles(string Level, List<DiffCycle> Resolved, List<DiffCycle> Added, List<DiffCycle> Changed, int Before, int After);

public sealed record DiffEdges(List<DiffDependency> Resolved, List<DiffDependency> Added, int Before, int After);

public sealed record DiffFindings(List<Finding> Resolved, List<Finding> Added, int Kept, int Before, int After, Dictionary<string, int> DeltaBySeverity);

public sealed record DiffMetric(string Node, string Metric, double Before, double After, double Delta);

/// <summary>
/// Compares two maps (before and after a refactoring, two commits, a map and its what-if simulation): nodes added,
/// removed, moved and renamed; dependencies at a level; cycles and upward dependencies resolved and new; findings
/// resolved and new; metric changes; and the health score with the change of each part.
/// </summary>
public static class GraphDiff
{
    public static GraphDiffReport Compare(GraphIndex before, FindingsReport beforeFindings, GraphIndex after, FindingsReport afterFindings, string level = NodeLevels.Namespace, int maxItems = 50)
    {
        var matcher = new NodeMatcher(before, after);
        string T(string id) => matcher.Translate(id);
        List<T2> Top<T2>(IEnumerable<T2> items) => items.Take(maxItems).ToList();

        // ------------------------------------------------------------------ nodes (types and containers)
        bool Counted(GraphNode n) => !n.External && NodeLevels.Of(n) != NodeLevels.Member;
        var added = after.Graph.Nodes.Where(n => Counted(n) && matcher.Before(n.Id) == null).Select(n => n.Id).OrderBy(i => i, StringComparer.Ordinal).ToList();
        var removed = before.Graph.Nodes.Where(n => Counted(n) && matcher.After(n.Id) == null).Select(n => n.Id).OrderBy(i => i, StringComparer.Ordinal).ToList();
        DiffMove Move((string Before, string After) pair) => new(pair.Before, pair.After, before.NamespaceOf(pair.Before) ?? before.ProjectOf(pair.Before), after.NamespaceOf(pair.After) ?? after.ProjectOf(pair.After));

        // Types that stayed under the same id but now live in another namespace (an id names the type, not its folder) count as moved too.
        var moved = matcher.Moved.Select(Move).ToList();
        foreach (var type in after.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && matcher.Before(n.Id) == n.Id))
        {
            var from = before.NamespaceOf(type.Id);
            var to = after.NamespaceOf(type.Id);
            if (from != null && to != null && T(from) != to) moved.Add(new DiffMove(type.Id, type.Id, from, to));
        }

        // ------------------------------------------------------------------ dependencies at the level
        var beforeDeps = new Dictionary<(string, string), int>();
        foreach (var d in before.Dependencies(level).Values)
        {
            var key = (T(d.Source), T(d.Target));
            if (key.Item1 != key.Item2) beforeDeps[key] = beforeDeps.GetValueOrDefault(key) + d.Weight;
        }

        var afterDeps = after.Dependencies(level).Values.ToDictionary(d => (d.Source, d.Target), d => d.Weight);
        var addedDeps = afterDeps.Where(p => !beforeDeps.ContainsKey(p.Key)).Select(p => new DiffDependency(p.Key.Item1, p.Key.Item2, 0, p.Value)).OrderByDescending(d => d.After).ToList();
        var removedDeps = beforeDeps.Where(p => !afterDeps.ContainsKey(p.Key)).Select(p => new DiffDependency(p.Key.Item1, p.Key.Item2, p.Value, 0)).OrderByDescending(d => d.Before).ToList();
        var changedDeps = afterDeps.Where(p => beforeDeps.TryGetValue(p.Key, out var w) && w != p.Value)
            .Select(p => new DiffDependency(p.Key.Item1, p.Key.Item2, beforeDeps[p.Key], p.Value)).OrderByDescending(d => Math.Abs(d.After - d.Before)).ToList();

        // ------------------------------------------------------------------ cycles
        var cycles = new List<DiffCycles>();
        foreach (var cycleLevel in new[] { NodeLevels.Project, NodeLevels.Namespace, NodeLevels.Type })
        {
            var b = before.Graph.Analysis.Cycles.Where(c => c.Level == cycleLevel).Select(c => c.Nodes.Select(T).ToHashSet(StringComparer.Ordinal)).ToList();
            var a = after.Graph.Analysis.Cycles.Where(c => c.Level == cycleLevel).Select(c => c.Nodes.ToHashSet(StringComparer.Ordinal)).ToList();
            bool Same(HashSet<string> x, HashSet<string> y) => x.Count(y.Contains) >= 2;
            var resolved = b.Where(x => !a.Any(y => Same(x, y))).Select(x => new DiffCycle(x.OrderBy(i => i, StringComparer.Ordinal).ToList(), x.Count, 0)).ToList();
            var appeared = a.Where(y => !b.Any(x => Same(x, y))).Select(y => new DiffCycle(y.OrderBy(i => i, StringComparer.Ordinal).ToList(), 0, y.Count)).ToList();
            var changed = a.Select(y => (After: y, Before: b.FirstOrDefault(x => Same(x, y))))
                .Where(p => p.Before != null && p.Before.Count != p.After.Count)
                .Select(p => new DiffCycle(p.After.OrderBy(i => i, StringComparer.Ordinal).ToList(), p.Before!.Count, p.After.Count)).ToList();
            if (b.Count + a.Count > 0) cycles.Add(new DiffCycles(cycleLevel, Top(resolved), Top(appeared), Top(changed), b.Count, a.Count));
        }

        // ------------------------------------------------------------------ upward dependencies
        HashSet<(string, string)> Up(GraphIndex index, Func<string, string> map) =>
            (index.Graph.Analysis.Layers.FirstOrDefault(l => l.Level == level)?.Upward ?? new List<GraphEdge>()).Select(e => (map(e.Source), map(e.Target))).ToHashSet();
        var upBefore = Up(before, T);
        var upAfter = Up(after, id => id);
        var upResolved = upBefore.Where(e => !upAfter.Contains(e)).Select(e => new DiffDependency(e.Item1, e.Item2, beforeDeps.GetValueOrDefault(e), afterDeps.GetValueOrDefault(e))).ToList();
        var upAdded = upAfter.Where(e => !upBefore.Contains(e)).Select(e => new DiffDependency(e.Item1, e.Item2, beforeDeps.GetValueOrDefault(e), afterDeps.GetValueOrDefault(e))).ToList();

        // ------------------------------------------------------------------ findings (their ids hold node ids: translated)
        // A part is a node id, or a node id with "#n" (the n-th finding of a rule in one node); TypeScript ids hold '#' themselves.
        string Part(string part)
        {
            if (matcher.After(part) is { } same) return same;
            var ordinal = System.Text.RegularExpressions.Regex.Match(part, @"^(.*)#(\d+)$");
            return ordinal.Success && matcher.After(ordinal.Groups[1].Value) is { } owner ? $"{owner}#{ordinal.Groups[2].Value}" : part;
        }

        string Key(Finding f) => f.Rule + "@" + string.Join("→", f.Id[(f.Id.IndexOf('@') + 1)..].Split('→').Select(Part));
        var beforeKeys = beforeFindings.Findings.GroupBy(Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var afterKeys = afterFindings.Findings.ToDictionary(f => f.Id, StringComparer.Ordinal);
        var findingsResolved = beforeKeys.Where(p => !afterKeys.ContainsKey(p.Key)).Select(p => p.Value).ToList();
        var findingsAdded = afterKeys.Where(p => !beforeKeys.ContainsKey(p.Key)).Select(p => p.Value).ToList();
        var deltaBySeverity = new[] { FindingSeverity.Error, FindingSeverity.Warning, FindingSeverity.Info }
            .ToDictionary(s => s, s => afterFindings.Findings.Count(f => f.Severity == s) - beforeFindings.Findings.Count(f => f.Severity == s));

        // ------------------------------------------------------------------ metrics of the containers at the level, and of types
        var metrics = new List<DiffMetric>();
        var containerMetrics = new[] { "ca", "ce", "instability", "abstractness", "distance", "types", "loc", "complexity" };
        foreach (var node in after.Graph.Nodes.Where(n => !n.External && (NodeLevels.Of(n) == level || NodeLevels.IsType(n))))
        {
            if (matcher.Before(node.Id) is not { } beforeId || before.Node(beforeId) is not { } old) continue;
            var names = NodeLevels.IsType(node) ? new[] { "complexity", "ca", "ce", "loc" } : containerMetrics;
            foreach (var metric in names)
            {
                var (x, y) = (old.Metric(metric), node.Metric(metric));
                var delta = Math.Round(y - x, 3);
                if (Math.Abs(delta) < (metric is "instability" or "abstractness" or "distance" ? 0.05 : 1)) continue;
                metrics.Add(new DiffMetric(node.Id, metric, Math.Round(x, 3), Math.Round(y, 3), delta));
            }
        }

        metrics = metrics.OrderBy(m => after.Node(m.Node) is { } n && NodeLevels.IsType(n) ? 1 : 0).ThenByDescending(m => Math.Abs(m.Delta) / Math.Max(1, Math.Abs(m.Before))).ThenBy(m => m.Node, StringComparer.Ordinal).ToList();

        // ------------------------------------------------------------------ score
        var sb = beforeFindings.Score;
        var sa = afterFindings.Score;
        var parts = sa.Components.Select(c =>
        {
            var old = sb.Components.FirstOrDefault(o => o.Name == c.Name)?.Penalty ?? 0;
            return new DiffScorePart(c.Name, old, c.Penalty, Math.Round(old - c.Penalty, 1));
        }).ToList();
        var score = new DiffScore(sb.Score, sa.Score, sa.Score - sb.Score, sb.Grade, sa.Grade, parts);

        Dictionary<string, int> Counts(GraphIndex index, FindingsReport findings)
        {
            var stats = index.Graph.Stats;
            return new Dictionary<string, int>(StringComparer.Ordinal)
            {
                ["types"] = stats.GetValueOrDefault("types"),
                ["members"] = stats.GetValueOrDefault("members"),
                ["edges"] = stats.GetValueOrDefault("edges"),
                ["cycles"] = index.Graph.Analysis.Cycles.Count,
                ["upward"] = index.Graph.Analysis.Layers.FirstOrDefault(l => l.Level == level)?.Upward.Count ?? 0,
                ["findings"] = findings.Findings.Count,
                ["diagnostics"] = index.Graph.Analysis.Diagnostics?.Count ?? 0,
            };
        }

        string Name(string id) => after.Node(id)?.FullName ?? after.Node(id)?.Name ?? before.Node(id)?.FullName ?? before.Node(id)?.Name ?? id;
        var summary = new List<string>
        {
            $"Health {sb.Score} → {sa.Score} ({(score.Delta >= 0 ? "+" : "")}{score.Delta}).",
            $"Findings: {findingsResolved.Count} resolved, {findingsAdded.Count} new (errors {Signed(deltaBySeverity[FindingSeverity.Error])}, warnings {Signed(deltaBySeverity[FindingSeverity.Warning])}).",
        };
        foreach (var c in cycles.Where(c => c.Resolved.Count + c.Added.Count > 0)) summary.Add($"{c.Level} cycles: {c.Before} → {c.After} ({c.Resolved.Count} resolved, {c.Added.Count} new).");
        if (upResolved.Count + upAdded.Count > 0) summary.Add($"Upward {level} dependencies: {upBefore.Count} → {upAfter.Count}.");
        if (moved.Count > 0) summary.Add($"Moved: {string.Join(", ", moved.Take(5).Select(m => $"{Name(m.After)} ({Name(m.FromContainer ?? "?")} → {Name(m.ToContainer ?? "?")})"))}{(moved.Count > 5 ? $" and {moved.Count - 5} more" : "")}.");
        if (added.Count + removed.Count > 0) summary.Add($"{added.Count} nodes added, {removed.Count} removed (types and containers).");
        foreach (var f in findingsAdded.Where(f => f.Severity != FindingSeverity.Info).Take(3)) summary.Add($"New {f.Severity}: {f.Title}.");

        return new GraphDiffReport
        {
            Score = score,
            Counts = new DiffCounts(Counts(before, beforeFindings), Counts(after, afterFindings)),
            Nodes = new DiffNodes(Top(added), Top(removed), Top(moved), Top(matcher.Renamed.Select(Move)), added.Count, removed.Count),
            Level = level,
            Dependencies = new DiffDependencies(Top(addedDeps), Top(removedDeps), Top(changedDeps), addedDeps.Count, removedDeps.Count, changedDeps.Count),
            Cycles = cycles,
            Upward = new DiffEdges(Top(upResolved), Top(upAdded), upBefore.Count, upAfter.Count),
            Findings = new DiffFindings(Top(findingsResolved), Top(findingsAdded), afterKeys.Count - findingsAdded.Count, beforeFindings.Findings.Count, afterFindings.Findings.Count, deltaBySeverity),
            Metrics = Top(metrics),
            Summary = summary,
        };

        static string Signed(int value) => value > 0 ? $"+{value}" : value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
}
