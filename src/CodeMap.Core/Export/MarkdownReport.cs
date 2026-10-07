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

        WriteLayers(sb, graph, byId);
        WriteDependencyInjection(sb, graph, Name);
        WriteChangeCoupling(sb, graph, Name);

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

    private static void WriteLayers(StringBuilder sb, CodeGraph graph, Dictionary<string, GraphNode> byId)
    {
        var info = graph.Analysis.Layers.FirstOrDefault(l => l.Level == "namespace") ?? graph.Analysis.Layers.FirstOrDefault();
        if (info == null || info.Layers.Count == 0) return;
        string Short(string id) => byId.TryGetValue(id, out var n) ? n.Name : id;

        sb.AppendLine();
        sb.AppendLine($"## Layers ({info.Level}s)");
        sb.AppendLine();
        sb.AppendLine("Computed from the code: everything depends only on layers below it, except the upward dependencies listed after the table.");
        sb.AppendLine();
        sb.AppendLine("| Layer | Members |");
        sb.AppendLine("|---|---|");
        for (var i = info.Layers.Count - 1; i >= 0; i--)
        {
            var members = info.Layers[i].Select(Short).ToList();
            sb.AppendLine($"| {i}{(i == info.Layers.Count - 1 ? " (top)" : i == 0 ? " (bottom)" : "")} | {string.Join(", ", members.Take(15))}{(members.Count > 15 ? $", … (+{members.Count - 15})" : "")} |");
        }

        sb.AppendLine();
        if (info.Upward.Count == 0)
        {
            sb.AppendLine("No upward dependencies: the layering is clean.");
            return;
        }

        sb.AppendLine($"**Upward dependencies ({info.Upward.Count})**: cutting these removes every {info.Level} cycle.");
        sb.AppendLine();
        foreach (var edge in info.Upward.Take(20)) sb.AppendLine($"- {Short(edge.Source)} → {Short(edge.Target)} ({edge.Weight} reference{(edge.Weight == 1 ? "" : "s")})");
    }

    private static void WriteDependencyInjection(StringBuilder sb, CodeGraph graph, Func<string, string> name)
    {
        var di = graph.Analysis.Di;
        if (di == null) return;
        sb.AppendLine();
        sb.AppendLine("## Dependency injection");
        sb.AppendLine();
        var lifetimes = di.Registrations.GroupBy(r => r.Lifetime).OrderBy(g => g.Key).Select(g => $"{g.Count()} {g.Key}");
        sb.AppendLine($"{di.Registrations.Count} registrations ({string.Join(", ", lifetimes)}), {di.Dependencies.Count} constructor dependencies resolved.");
        if (di.Issues.Count == 0)
        {
            sb.AppendLine();
            sb.AppendLine("No lifetime problems or missing registrations found.");
            return;
        }

        sb.AppendLine();
        foreach (var issue in di.Issues.Take(40))
        {
            sb.AppendLine($"- **{issue.Severity}** ({issue.Kind}): {issue.Message}");
        }
    }

    private static void WriteChangeCoupling(StringBuilder sb, CodeGraph graph, Func<string, string> name)
    {
        var hidden = graph.Analysis.ChangeCoupling.Where(c => c.Hidden).ToList();
        if (hidden.Count == 0) return;
        sb.AppendLine();
        sb.AppendLine("## Hidden change coupling (git)");
        sb.AppendLine();
        sb.AppendLine("These types keep changing in the same commits although neither uses the other: a shared assumption the compiler cannot check.");
        sb.AppendLine();
        sb.AppendLine("| Type | Type | Shared commits | Strength |");
        sb.AppendLine("|---|---|---|---|");
        foreach (var pair in hidden.Take(15))
        {
            sb.AppendLine($"| {name(pair.Source)} | {name(pair.Target)} | {pair.SharedCommits} | {pair.Strength:P0} |");
        }
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
