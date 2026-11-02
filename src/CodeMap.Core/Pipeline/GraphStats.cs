using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>The counts in <see cref="CodeGraph.Stats"/>.</summary>
internal static class GraphStats
{
    public static Dictionary<string, int> Compute(CodeGraph graph)
    {
        var internalNodes = graph.Nodes.Where(n => !n.External).ToList();
        var stats = new Dictionary<string, int>
        {
            ["projects"] = internalNodes.Count(n => n.Kind == NodeKinds.Project),
            ["namespaces"] = internalNodes.Count(n => n.Kind == NodeKinds.Namespace),
            ["types"] = internalNodes.Count(NodeLevels.IsType),
            ["members"] = internalNodes.Count(NodeLevels.IsMember),
            ["packages"] = graph.Nodes.Count(n => n.Kind == NodeKinds.Package),
            ["externalTypes"] = graph.Nodes.Count(n => n.External && NodeLevels.IsType(n)),
            ["edges"] = graph.Edges.Count,
            ["files"] = (int)internalNodes.Where(n => n.Kind == NodeKinds.Project).Sum(n => n.Metric("files")),
            ["lines"] = (int)internalNodes.Where(n => n.Kind == NodeKinds.Project).Sum(n => n.Metric("lines")),
            ["cycles"] = graph.Analysis.Cycles.Count,
        };
        foreach (var group in graph.Edges.GroupBy(e => e.Kind)) stats["edges." + group.Key] = group.Count();
        return stats;
    }
}
