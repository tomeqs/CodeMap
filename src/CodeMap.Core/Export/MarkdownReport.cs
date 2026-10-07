using System.Globalization;
using System.Text;
using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>Human (and LLM) friendly summary of the architecture: projects, coupling, cycles, hotspots, dead code.</summary>
public static class MarkdownReport
{
    public static string Export(CodeGraph graph)
    {
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        string Name(string id) => byId.TryGetValue(id, out var n) ? n.FullName ?? n.Name : id;
        string F(double v) => v.ToString(v % 1 == 0 ? "0" : "0.00", CultureInfo.InvariantCulture);

        var sb = new StringBuilder();
        sb.AppendLine($"# CodeMap: {graph.Source.Name}");
        sb.AppendLine();
        sb.AppendLine($"Generated {graph.GeneratedAt:yyyy-MM-dd HH:mm} UTC from `{graph.Source.Path}`.");
        if (graph.Source.Git is { } git) sb.AppendLine($"Git: branch `{git.Branch}`, commit `{git.Commit?[..Math.Min(8, git.Commit.Length)]}`, {git.CommitsAnalyzed} commits analyzed.");
        sb.AppendLine();

        sb.AppendLine("## Overview");
        sb.AppendLine();
        sb.AppendLine("| Metric | Value |");
        sb.AppendLine("|---|---|");
        foreach (var key in new[] { "projects", "namespaces", "types", "members", "files", "lines", "edges", "packages", "cycles" })
        {
            if (graph.Stats.TryGetValue(key, out var value)) sb.AppendLine($"| {key} | {value} |");
        }

        sb.AppendLine();
        sb.AppendLine("## Projects");
        sb.AppendLine();
        sb.AppendLine("| Project | Types | LOC | Complexity | Ca | Ce | Instability | Abstractness | Distance | References |");
        sb.AppendLine("|---|---|---|---|---|---|---|---|---|---|");
        foreach (var project in graph.Nodes.Where(n => n.Kind == NodeKinds.Project))
        {
            var references = graph.Edges.Where(e => e.Source == project.Id && e.Kind == EdgeKinds.ProjectReference).Select(e => byId.TryGetValue(e.Target, out var t) ? t.Name : e.Target);
            sb.AppendLine($"| {project.Name} | {F(project.Metric("types"))} | {F(project.Metric("loc"))} | {F(project.Metric("complexity"))} | {F(project.Metric("ca"))} | {F(project.Metric("ce"))} | {F(project.Metric("instability"))} | {F(project.Metric("abstractness"))} | {F(project.Metric("distance"))} | {string.Join(", ", references)} |");
        }

        if (graph.Analysis.Cycles.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Dependency cycles");
            sb.AppendLine();
            foreach (var cycle in graph.Analysis.Cycles.Take(30))
            {
                sb.AppendLine($"- **{cycle.Level}** ({cycle.Nodes.Count}): {string.Join(" ↔ ", cycle.Nodes.Take(12).Select(Name))}{(cycle.Nodes.Count > 12 ? " …" : "")}");
            }
        }

        WriteRanking(sb, "Hotspots (complexity × change frequency)", graph.Analysis.Hotspots, Name, byId, "hotspot", "commits", "complexity");
        WriteRanking(sb, "Most complex types", graph.Analysis.MostComplex, Name, byId, "complexity", "loc", "members");
        WriteRanking(sb, "Most depended-upon types (afferent coupling)", graph.Analysis.MostDepended, Name, byId, "ca", "ce", "instability");

        var tagged = graph.Nodes.Where(n => n.Tags != null && NodeKinds.IsType(n.Kind) && !n.External)
            .SelectMany(n => n.Tags!.Select(t => (Tag: t, Node: n)))
            .GroupBy(x => x.Tag)
            .Where(g => g.Key is not (Tags.Unused or Tags.InCycle or Tags.Hotspot))
            .OrderByDescending(g => g.Count())
            .ToList();
        if (tagged.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Recognised roles");
            sb.AppendLine();
            foreach (var group in tagged)
            {
                var names = group.Select(x => x.Node.Name).OrderBy(n => n).ToList();
                sb.AppendLine($"- **{group.Key}** ({names.Count}): {string.Join(", ", names.Take(20))}{(names.Count > 20 ? ", …" : "")}");
            }
        }

        if (graph.Analysis.UnusedCandidates.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Possibly unused (non-public, nothing references them)");
            sb.AppendLine();
            foreach (var id in graph.Analysis.UnusedCandidates.Take(100))
            {
                var node = byId[id];
                sb.AppendLine($"- `{node.FullName ?? node.Name}` ({node.Kind}){(node.Location != null ? $" — {node.Location.File}:{node.Location.Line}" : "")}");
            }

            if (graph.Analysis.UnusedCandidates.Count > 100) sb.AppendLine($"- … and {graph.Analysis.UnusedCandidates.Count - 100} more");
        }

        if (graph.Analysis.Warnings.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Warnings");
            sb.AppendLine();
            foreach (var warning in graph.Analysis.Warnings.Take(50)) sb.AppendLine($"- {warning}");
        }

        return sb.ToString();
    }

    private static void WriteRanking(StringBuilder sb, string title, List<RankedItem> items, Func<string, string> name,
        Dictionary<string, GraphNode> byId, params string[] metrics)
    {
        if (items.Count == 0) return;
        sb.AppendLine();
        sb.AppendLine($"## {title}");
        sb.AppendLine();
        sb.AppendLine("| Type | " + string.Join(" | ", metrics) + " | File |");
        sb.AppendLine("|---|" + string.Concat(metrics.Select(_ => "---|")) + "---|");
        foreach (var item in items.Take(15))
        {
            var node = byId[item.Id];
            var values = metrics.Select(m => node.Metric(m).ToString("0.###", CultureInfo.InvariantCulture));
            sb.AppendLine($"| {name(item.Id)} | {string.Join(" | ", values)} | {node.Location?.File} |");
        }
    }
}
