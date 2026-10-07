using System.Globalization;
using System.Xml.Linq;
using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>GraphML – readable by Gephi, yEd, Cytoscape, NetworkX, igraph... Contains every node and edge.</summary>
public static class GraphMLExporter
{
    private static readonly XNamespace Ns = "http://graphml.graphdrawing.org/xmlns";

    private static readonly string[] NodeMetrics = { "loc", "complexity", "members", "ca", "ce", "instability", "dit", "commits", "churn", "hotspot" };

    public static XDocument Export(CodeGraph graph)
    {
        var keys = new List<XElement>
        {
            Key("kind", "node", "string"), Key("label", "node", "string"), Key("fullName", "node", "string"),
            Key("project", "node", "string"), Key("namespace", "node", "string"), Key("accessibility", "node", "string"),
            Key("file", "node", "string"), Key("line", "node", "int"), Key("tags", "node", "string"), Key("external", "node", "boolean"),
            Key("edgeKind", "edge", "string", "kind"), Key("weight", "edge", "int"),
        };
        keys.AddRange(NodeMetrics.Select(m => Key(m, "node", "double")));

        var g = new XElement(Ns + "graph", new XAttribute("id", graph.Source.Name), new XAttribute("edgedefault", "directed"));

        foreach (var node in graph.Nodes)
        {
            var element = new XElement(Ns + "node", new XAttribute("id", node.Id),
                Data("kind", node.Kind), Data("label", node.Name));
            AddData(element, "fullName", node.FullName);
            AddData(element, "project", node.Project);
            AddData(element, "namespace", node.Namespace);
            AddData(element, "accessibility", node.Accessibility);
            AddData(element, "file", node.Location?.File);
            AddData(element, "line", node.Location?.Line.ToString(CultureInfo.InvariantCulture));
            AddData(element, "tags", node.Tags is { Count: > 0 } ? string.Join(",", node.Tags) : null);
            if (node.External) element.Add(Data("external", "true"));
            foreach (var metric in NodeMetrics)
            {
                if (node.Metrics?.TryGetValue(metric, out var value) == true) element.Add(Data(metric, value.ToString(CultureInfo.InvariantCulture)));
            }

            g.Add(element);
        }

        var i = 0;
        foreach (var node in graph.Nodes.Where(n => n.Parent != null))
        {
            g.Add(new XElement(Ns + "edge", new XAttribute("id", "c" + i++), new XAttribute("source", node.Parent!), new XAttribute("target", node.Id),
                Data("edgeKind", EdgeKinds.Contains), Data("weight", "1")));
        }

        foreach (var edge in graph.Edges)
        {
            g.Add(new XElement(Ns + "edge", new XAttribute("id", "e" + i++), new XAttribute("source", edge.Source), new XAttribute("target", edge.Target),
                Data("edgeKind", edge.Kind), Data("weight", edge.Weight.ToString(CultureInfo.InvariantCulture))));
        }

        return new XDocument(new XDeclaration("1.0", "utf-8", null), new XElement(Ns + "graphml", keys, g));
    }

    private static XElement Key(string id, string domain, string type, string? name = null) =>
        new(Ns + "key", new XAttribute("id", id), new XAttribute("for", domain), new XAttribute("attr.name", name ?? id), new XAttribute("attr.type", type));

    private static XElement Data(string key, string value) => new(Ns + "data", new XAttribute("key", key), value);

    private static void AddData(XElement element, string key, string? value)
    {
        if (!string.IsNullOrEmpty(value)) element.Add(Data(key, value));
    }
}
