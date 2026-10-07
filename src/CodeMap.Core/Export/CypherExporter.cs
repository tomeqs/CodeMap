using System.Globalization;
using System.Text;
using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>
/// Neo4j / Memgraph import script. Every node gets the <c>:Code</c> label plus a label per kind
/// (<c>:Class</c>, <c>:Method</c>...), relationships get UPPER_SNAKE names (<c>:CALLS</c>, <c>:IMPLEMENTS</c>...).
/// </summary>
public static class CypherExporter
{
    private const int BatchSize = 500;

    public static string Export(CodeGraph graph)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"// CodeMap export of {graph.Source.Name} ({graph.GeneratedAt:u})");
        sb.AppendLine("// Run with: cypher-shell -f <file>  (or paste into Neo4j Browser with multi-statement mode)");
        sb.AppendLine("CREATE CONSTRAINT code_id IF NOT EXISTS FOR (n:Code) REQUIRE n.id IS UNIQUE;");
        sb.AppendLine();

        foreach (var group in graph.Nodes.GroupBy(n => n.Kind))
        {
            var label = Label(group.Key);
            foreach (var batch in group.Chunk(BatchSize))
            {
                sb.Append("UNWIND [");
                sb.Append(string.Join(",\n  ", batch.Select(NodeMap)));
                sb.AppendLine($"] AS row CREATE (n:Code:{label}) SET n = row;");
            }
        }

        sb.AppendLine();
        var containment = graph.Nodes.Where(n => n.Parent != null).Select(n => new GraphEdge { Source = n.Parent!, Target = n.Id, Kind = EdgeKinds.Contains });
        foreach (var group in containment.Concat(graph.Edges).GroupBy(e => e.Kind))
        {
            var type = RelationshipType(group.Key);
            foreach (var batch in group.Chunk(BatchSize))
            {
                sb.Append("UNWIND [");
                sb.Append(string.Join(",\n  ", batch.Select(e => $"{{s:{Str(e.Source)},t:{Str(e.Target)},w:{e.Weight}}}")));
                sb.AppendLine($"] AS row MATCH (a:Code {{id: row.s}}), (b:Code {{id: row.t}}) CREATE (a)-[:{type} {{weight: row.w}}]->(b);");
            }
        }

        return sb.ToString();
    }

    private static string NodeMap(GraphNode node)
    {
        var props = new List<string>
        {
            "id:" + Str(node.Id),
            "kind:" + Str(node.Kind),
            "name:" + Str(node.Name),
        };
        if (node.FullName != null) props.Add("fullName:" + Str(node.FullName));
        if (node.Project != null) props.Add("project:" + Str(node.Project));
        if (node.Namespace != null) props.Add("namespace:" + Str(node.Namespace));
        if (node.Accessibility != null) props.Add("accessibility:" + Str(node.Accessibility));
        if (node.Signature != null) props.Add("signature:" + Str(node.Signature));
        if (node.Location != null)
        {
            props.Add("file:" + Str(node.Location.File));
            props.Add("line:" + node.Location.Line.ToString(CultureInfo.InvariantCulture));
        }

        if (node.Tags is { Count: > 0 }) props.Add("tags:[" + string.Join(",", node.Tags.Select(Str)) + "]");
        if (node.External) props.Add("external:true");
        if (node.Metrics != null)
        {
            foreach (var (name, value) in node.Metrics) props.Add($"{name}:{value.ToString(CultureInfo.InvariantCulture)}");
        }

        return "{" + string.Join(",", props) + "}";
    }

    private static string Label(string kind) => char.ToUpperInvariant(kind[0]) + kind[1..];

    private static string RelationshipType(string kind)
    {
        var sb = new StringBuilder();
        foreach (var c in kind)
        {
            if (char.IsUpper(c) && sb.Length > 0) sb.Append('_');
            sb.Append(char.ToUpperInvariant(c));
        }

        return sb.ToString();
    }

    private static string Str(string value) =>
        "'" + value.Replace("\\", "\\\\").Replace("'", "\\'").Replace("\n", "\\n").Replace("\r", "") + "'";
}
