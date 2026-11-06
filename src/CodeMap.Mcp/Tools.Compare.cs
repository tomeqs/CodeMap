using CodeMap.Insights;
using CodeMap.Model;

namespace CodeMap.Mcp;

internal static partial class Tools
{
    private static readonly ToolDef Compare = new("compare", "Compare two maps",
        "What changed between two maps: the health score and each of its parts, findings resolved and new, cycles and upward " +
        "dependencies resolved and new, dependencies added, removed and reweighted at a level, nodes added, removed, moved and " +
        "renamed, metric changes. Typical use: snapshots save 'before', edit the code, analyze refresh, compare before → current.",
        """
        {"type":"object","properties":{
          "before":{"type":"string","description":"The earlier graph: a baseline name, previous, or a .codemap.json path. Default: the last saved baseline, else previous."},
          "after":{"type":"string","description":"The later graph (default current)."},
          "level":{"type":"string","enum":["project","namespace"],"description":"Level of the dependency and metric comparison (default namespace)."},
          "limit":{"type":"number","description":"Items per list (default 20)."}
        }}
        """,
        async (call, ct) =>
        {
            var session = call.Session;
            var beforeRef = call.String("before") ?? session.BaselineNames().LastOrDefault() ?? "previous";
            var before = await session.GraphAsync(beforeRef, ct).ConfigureAwait(false);
            var after = await session.GraphAsync(call.String("after"), ct).ConfigureAwait(false);
            if (ReferenceEquals(before, after)) throw new ToolException($"'{beforeRef}' and the current map are the same analysis: change the code and analyze with refresh: true first.");
            var level = call.Choice("level", NodeLevels.Namespace, NodeLevels.Project, NodeLevels.Namespace);
            var limit = call.Int("limit", 20, 1, 200);
            var diff = GraphDiff.Compare(before.Index, before.Findings, after.Index, after.Findings, level, limit);

            string Name(string id) => after.Index.Node(id)?.FullName ?? after.Index.Node(id)?.Name ?? before.Index.Node(id)?.FullName ?? before.Index.Node(id)?.Name ?? id;
            object Dep(DiffDependency d) => new { from = Name(d.Source), to = Name(d.Target), before = d.Before, after = d.After };
            object Cycle(DiffCycle c) => new { size = c.SizeAfter > 0 ? c.SizeAfter : c.SizeBefore, sizeBefore = c.SizeBefore, nodes = c.Nodes.Take(12).Select(Name).ToList() };
            object Move(DiffMove m) => new { node = Name(m.After), id = m.After, previousId = m.Before == m.After ? null : m.Before, from = m.FromContainer != null ? Name(m.FromContainer) : null, to = m.ToContainer != null ? Name(m.ToContainer) : null };

            return new
            {
                before = new { graph = beforeRef, analyzedAt = before.At.ToString("u", System.Globalization.CultureInfo.InvariantCulture) },
                after = new { graph = call.String("after") ?? "current", analyzedAt = after.At.ToString("u", System.Globalization.CultureInfo.InvariantCulture) },
                summary = diff.Summary,
                score = diff.Score,
                counts = diff.Counts,
                findings = new
                {
                    resolved = diff.Findings.Resolved.Select(Answers.Brief).ToList(),
                    added = diff.Findings.Added.Select(Answers.Brief).ToList(),
                    kept = diff.Findings.Kept,
                    deltaBySeverity = diff.Findings.DeltaBySeverity,
                },
                cycles = diff.Cycles.Select(c => new { c.Level, c.Before, c.After, resolved = c.Resolved.Select(Cycle).ToList(), added = c.Added.Select(Cycle).ToList(), changed = c.Changed.Select(Cycle).ToList() }).ToList(),
                upward = new { level, diff.Upward.Before, diff.Upward.After, resolved = diff.Upward.Resolved.Select(Dep).ToList(), added = diff.Upward.Added.Select(Dep).ToList() },
                dependencies = new
                {
                    level,
                    added = diff.Dependencies.Added.Select(Dep).ToList(),
                    removed = diff.Dependencies.Removed.Select(Dep).ToList(),
                    changed = diff.Dependencies.Changed.Select(Dep).ToList(),
                    totals = new { added = diff.Dependencies.AddedTotal, removed = diff.Dependencies.RemovedTotal, changed = diff.Dependencies.ChangedTotal },
                },
                nodes = new
                {
                    added = diff.Nodes.Added.Select(Name).ToList(),
                    removed = diff.Nodes.Removed.Select(Name).ToList(),
                    moved = diff.Nodes.Moved.Select(Move).ToList(),
                    renamed = diff.Nodes.Renamed.Select(Move).ToList(),
                    totals = new { added = diff.Nodes.AddedTotal, removed = diff.Nodes.RemovedTotal },
                },
                metrics = diff.Metrics.Select(m => new { node = Name(m.Node), m.Metric, m.Before, m.After, m.Delta }).ToList(),
            };
        });
}
