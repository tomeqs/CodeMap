using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>Helpers shared by exporters: indexing and rolling member-level edges up to types.</summary>
public static class GraphView
{
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
            while (node != null && NodeKinds.IsMember(node.Kind)) node = node.Parent != null ? byId.GetValueOrDefault(node.Parent) : null;
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
