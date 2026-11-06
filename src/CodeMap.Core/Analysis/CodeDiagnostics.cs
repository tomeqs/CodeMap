using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>What every language does with its diagnostics: order them, keep a bounded number, attach them to nodes.</summary>
public static class CodeDiagnostics
{
    /// <summary>At most this many diagnostics of one rule in one project: past that, the rule is the news, not each place.</summary>
    public const int MaxPerRule = 300;

    /// <summary>By file, line, column and rule.</summary>
    public static List<CodeDiagnostic> Sorted(IEnumerable<CodeDiagnostic> diagnostics) => diagnostics
        .OrderBy(d => d.Location.File, StringComparer.Ordinal)
        .ThenBy(d => d.Location.Line)
        .ThenBy(d => d.Column)
        .ThenBy(d => d.Rule, StringComparer.Ordinal)
        .ToList();

    /// <summary>The first <see cref="MaxPerRule"/> of each rule (in file order).</summary>
    public static IEnumerable<CodeDiagnostic> Capped(IEnumerable<CodeDiagnostic> diagnostics) =>
        Sorted(diagnostics).GroupBy(d => d.Rule, StringComparer.Ordinal).SelectMany(g => g.Take(MaxPerRule));

    /// <summary>
    /// Gives every diagnostic without a node the innermost node whose declaration holds its line (a member, else its type
    /// or file), so findings and the map can point at it.
    /// </summary>
    public static void Place(CodeGraph graph)
    {
        if (graph.Analysis.Diagnostics is not { Count: > 0 } diagnostics) return;
        var ids = graph.Nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        var byFile = new Dictionary<string, List<(GraphNode Node, int Line, int EndLine)>>(StringComparer.Ordinal);
        foreach (var node in graph.Nodes.Where(n => !n.External))
        {
            foreach (var location in new[] { node.Location }.Concat(node.ExtraLocations ?? new List<SourceLocation>()))
            {
                if (location == null) continue;
                if (!byFile.TryGetValue(location.File, out var list)) byFile[location.File] = list = new();
                list.Add((node, location.Line, Math.Max(location.Line, location.EndLine)));
            }
        }

        foreach (var diagnostic in diagnostics)
        {
            if (diagnostic.Node != null && ids.Contains(diagnostic.Node)) continue;
            diagnostic.Node = null;
            if (!byFile.TryGetValue(diagnostic.Location.File, out var candidates)) continue;
            var line = diagnostic.Location.Line;
            diagnostic.Node = candidates
                .Where(c => c.Line <= line && line <= c.EndLine)
                .OrderBy(c => c.EndLine - c.Line)
                .ThenByDescending(c => Array.IndexOf(new[] { NodeLevels.Project, NodeLevels.Namespace, NodeLevels.Type, NodeLevels.Member }, NodeLevels.Of(c.Node)))
                .Select(c => c.Node.Id)
                .FirstOrDefault();
        }
    }
}
