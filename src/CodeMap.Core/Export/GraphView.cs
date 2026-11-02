using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>Helpers shared by exporters: indexing and rolling member-level edges up to types.</summary>
public static class GraphView
{
    /// <summary>
    /// Drops member nodes and lifts their relationships to the declaring types – a much smaller file
    /// for very large solutions. Metrics computed from members are kept on the types.
    /// </summary>
    public static void CollapseMembers(CodeGraph graph)
    {
        var edges = TypeLevelEdges(graph);
        graph.Nodes.RemoveAll(NodeLevels.IsMember);
        var ids = graph.Nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        graph.Analysis.UnusedCandidates.RemoveAll(id => !ids.Contains(id));
        graph.Edges = edges.OrderBy(e => e.Source, StringComparer.Ordinal).ThenBy(e => e.Kind, StringComparer.Ordinal).ThenBy(e => e.Target, StringComparer.Ordinal).ToList();
        graph.Stats["edges"] = graph.Edges.Count;
        foreach (var key in graph.Stats.Keys.Where(k => k.StartsWith("edges.", StringComparison.Ordinal)).ToList()) graph.Stats.Remove(key);
        foreach (var group in graph.Edges.GroupBy(e => e.Kind)) graph.Stats["edges." + group.Key] = group.Count();
    }

    /// <summary>
    /// Aggregates every edge to the type level (members are replaced by their declaring type) and
    /// returns distinct (source, target, kind) triples with summed weights. Self loops are dropped.
    /// </summary>
    public static List<GraphEdge> TypeLevelEdges(CodeGraph graph)
    {
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);

        string? Lift(string id)
        {
            var node = byId.GetValueOrDefault(id);
            while (node != null && NodeLevels.IsMember(node)) node = node.Parent != null ? byId.GetValueOrDefault(node.Parent) : null;
            return node?.Id;
        }

        var result = new Dictionary<(string, string, string), GraphEdge>();
        foreach (var edge in graph.Edges)
        {
            var source = Lift(edge.Source);
            var target = Lift(edge.Target);
            if (source == null || target == null || source == target) continue;
            var key = (source, target, edge.Kind);
            if (result.TryGetValue(key, out var existing)) existing.Weight += edge.Weight;
            else result[key] = new GraphEdge { Source = source, Target = target, Kind = edge.Kind, Weight = edge.Weight };
        }

        return result.Values.ToList();
    }
}
