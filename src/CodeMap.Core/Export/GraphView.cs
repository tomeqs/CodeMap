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
        // The method that registers a service (AddInfrastructure) is gone with the members: its type registers it.
        var lift = Lifter(graph);
        foreach (var registration in graph.Analysis.Di?.Registrations ?? new List<ServiceRegistration>())
        {
            if (registration.RegisteredIn != null) registration.RegisteredIn = lift(registration.RegisteredIn);
        }

        graph.Nodes.RemoveAll(NodeLevels.IsMember);
        var ids = graph.Nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        graph.Analysis.UnusedCandidates.RemoveAll(id => !ids.Contains(id));
        graph.Edges = edges.OrderBy(e => e.Source, StringComparer.Ordinal).ThenBy(e => e.Kind, StringComparer.Ordinal).ThenBy(e => e.Target, StringComparer.Ordinal).ToList();
        graph.Stats = Pipeline.GraphStats.Compute(graph); // the counts of what the map now holds
    }

    /// <summary>The type (or other non-member node) a node id stands for once members are folded into their types.</summary>
    private static Func<string, string?> Lifter(CodeGraph graph)
    {
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        return id =>
        {
            var node = byId.GetValueOrDefault(id);
            while (node != null && NodeLevels.IsMember(node)) node = node.Parent != null ? byId.GetValueOrDefault(node.Parent) : null;
            return node?.Id;
        };
    }

    /// <summary>
    /// Aggregates every edge to the type level (members are replaced by their declaring type) and
    /// returns distinct (source, target, kind) triples with summed weights. Self loops are dropped.
    /// </summary>
    public static List<GraphEdge> TypeLevelEdges(CodeGraph graph)
    {
        var lift = Lifter(graph);
        var result = new Dictionary<(string, string, string), GraphEdge>();
        foreach (var edge in graph.Edges)
        {
            var source = lift(edge.Source);
            var target = lift(edge.Target);
            if (source == null || target == null || source == target) continue;
            var key = (source, target, edge.Kind);
            if (result.TryGetValue(key, out var existing)) existing.Weight += edge.Weight;
            else result[key] = new GraphEdge { Source = source, Target = target, Kind = edge.Kind, Weight = edge.Weight };
        }

        return result.Values.ToList();
    }
}
