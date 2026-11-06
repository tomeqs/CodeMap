using CodeMap.Export;
using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>
/// Temporal ("change") coupling: types whose files are modified in the same commits. Pairs without any
/// code dependency between them are hidden coupling – a shared assumption the compiler cannot see
/// (duplicated rules, serialization formats, a mapper and its DTO...).
/// </summary>
public static class ChangeCouplingAnalysis
{
    /// <summary>Bigger commits are bulk renames / formatting / merges and would couple everything.</summary>
    public const int MaxFilesPerCommit = 40;

    public const int MaxPairs = 400;

    public static void Compute(CodeGraph graph, GitHistory history, string root, int minShared = 0, double minStrength = 0.3)
    {
        var owners = FileOwners(graph, root);
        if (owners.Count == 0) return;

        var revisions = new Dictionary<string, int>(StringComparer.Ordinal);
        var shared = new Dictionary<(string A, string B), int>();
        foreach (var files in history.Commits)
        {
            if (files.Length > MaxFilesPerCommit) continue;
            var types = files
                .Select(f => owners.TryGetValue(f, out var owner) ? owner.Id : null)
                .Where(id => id != null)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(id => id, StringComparer.Ordinal)
                .ToArray();

            foreach (var type in types) revisions[type!] = revisions.GetValueOrDefault(type!) + 1;
            for (var i = 0; i < types.Length; i++)
            {
                for (var j = i + 1; j < types.Length; j++)
                {
                    var key = (types[i]!, types[j]!);
                    shared[key] = shared.GetValueOrDefault(key) + 1;
                }
            }
        }

        if (minShared <= 0) minShared = history.CommitCount < 30 ? 2 : 3;

        var pairs = shared
            .Where(p => p.Value >= minShared)
            .Select(p => new ChangeCouplingInfo
            {
                Source = p.Key.A,
                Target = p.Key.B,
                SharedCommits = p.Value,
                Strength = Math.Round(2.0 * p.Value / (revisions[p.Key.A] + revisions[p.Key.B]), 3),
            })
            .Where(p => p.Strength >= minStrength)
            .OrderByDescending(p => p.SharedCommits * p.Strength)
            .ThenBy(p => p.Source, StringComparer.Ordinal)
            .ThenBy(p => p.Target, StringComparer.Ordinal)
            .Take(MaxPairs)
            .ToList();
        Attach(graph, pairs);
    }

    /// <summary>
    /// Puts coupled pairs (strongest first) on the graph: in the analysis, as <c>changesWith</c> edges, and marked
    /// hidden when no code dependency joins the two.
    /// </summary>
    internal static void Attach(CodeGraph graph, List<ChangeCouplingInfo> pairs)
    {
        // Code dependencies between types in either direction (members rolled up to their type).
        var dependent = new HashSet<(string, string)>();
        foreach (var edge in GraphView.TypeLevelEdges(graph))
        {
            if (!EdgeKinds.IsDependency(edge.Kind)) continue;
            dependent.Add(Ordered(edge.Source, edge.Target));
        }

        foreach (var pair in pairs) pair.Hidden = !dependent.Contains(Ordered(pair.Source, pair.Target));
        graph.Analysis.ChangeCoupling = pairs;
        foreach (var pair in pairs)
        {
            graph.Edges.Add(new GraphEdge { Source = pair.Source, Target = pair.Target, Kind = EdgeKinds.ChangesWith, Weight = pair.SharedCommits });
        }
    }

    /// <summary>Maps every source file to the largest top-level type declared in it.</summary>
    private static Dictionary<string, (string Id, double Loc)> FileOwners(CodeGraph graph, string root)
    {
        var comparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        var owners = new Dictionary<string, (string Id, double Loc)>(comparer);
        foreach (var node in graph.Nodes)
        {
            if (!NodeLevels.IsType(node) || node.External || node.Location == null) continue;
            if (node.Parent != null && byId.TryGetValue(node.Parent, out var parent) && NodeLevels.IsType(parent)) continue; // nested

            var locations = new[] { node.Location }.Concat(node.ExtraLocations ?? new List<SourceLocation>());
            foreach (var location in locations)
            {
                var file = Path.GetFullPath(Path.Combine(root, location.File));
                var size = location.EndLine - location.Line + 1;
                if (!owners.TryGetValue(file, out var current) || size > current.Loc) owners[file] = (node.Id, size);
            }
        }

        return owners;
    }

    private static (string, string) Ordered(string a, string b) => string.CompareOrdinal(a, b) <= 0 ? (a, b) : (b, a);
}
