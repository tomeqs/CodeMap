using System.Globalization;
using System.Xml.Linq;
using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>
/// Directed Graph Markup Language – opens natively in Visual Studio ("Code Map" / DGML editor).
/// Projects, namespaces and types become nested groups; relationships are rolled up to type level.
/// </summary>
public static class DgmlExporter
{
    private static readonly XNamespace Ns = "http://schemas.microsoft.com/vs/2009/dgml";

    private static readonly Dictionary<string, string> CategoryColors = new()
    {
        [NodeKinds.Project] = "#FF3B4A6B",
        [NodeKinds.Namespace] = "#FF5B6B8B",
        [NodeKinds.Class] = "#FF4F8EF7",
        [NodeKinds.Interface] = "#FF35C9A5",
        [NodeKinds.Struct] = "#FFF5A524",
        [NodeKinds.Record] = "#FFB07CF7",
        [NodeKinds.RecordStruct] = "#FFB07CF7",
        [NodeKinds.Enum] = "#FFF06292",
        [NodeKinds.Delegate] = "#FF9E9E9E",
        [NodeKinds.Package] = "#FF795548",
    };

    private static readonly Dictionary<string, string> EdgeColors = new()
    {
        [EdgeKinds.Inherits] = "#FF4F8EF7",
        [EdgeKinds.Implements] = "#FF35C9A5",
        [EdgeKinds.Calls] = "#FFFFB74D",
        [EdgeKinds.Instantiates] = "#FFE57373",
        [EdgeKinds.Injects] = "#FFBA68C8",
        [EdgeKinds.Holds] = "#FF81C784",
        [EdgeKinds.ProjectReference] = "#FF90A4AE",
    };

    public static XDocument Export(CodeGraph graph)
    {
        var included = graph.Nodes
            .Where(n => n.Kind is NodeKinds.Project or NodeKinds.Namespace or NodeKinds.Package || NodeLevels.IsType(n))
            .ToList();
        var ids = included.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        var parents = included.Where(n => n.Parent != null).Select(n => n.Parent!).ToHashSet(StringComparer.Ordinal);

        var nodes = new XElement(Ns + "Nodes");
        foreach (var node in included)
        {
            var element = new XElement(Ns + "Node",
                new XAttribute("Id", node.Id),
                new XAttribute("Label", node.Name),
                new XAttribute("Category", node.Kind));
            if (parents.Contains(node.Id)) element.Add(new XAttribute("Group", "Collapsed"));
            if (node.Location != null) element.Add(new XAttribute("Reference", node.Location.File));
            if (node.FullName != null) element.Add(new XAttribute("FullName", node.FullName));
            if (node.Metrics != null)
            {
                foreach (var metric in new[] { "loc", "complexity", "ca", "ce", "instability", "commits", "hotspot" })
                {
                    if (node.Metrics.TryGetValue(metric, out var value)) element.Add(new XAttribute(Capitalize(metric), value.ToString(CultureInfo.InvariantCulture)));
                }
            }

            if (node.Tags is { Count: > 0 }) element.Add(new XAttribute("Tags", string.Join(", ", node.Tags)));
            nodes.Add(element);
        }

        var links = new XElement(Ns + "Links");
        foreach (var node in included.Where(n => n.Parent != null && ids.Contains(n.Parent)))
        {
            links.Add(new XElement(Ns + "Link", new XAttribute("Source", node.Parent!), new XAttribute("Target", node.Id), new XAttribute("Category", "Contains")));
        }

        foreach (var edge in GraphView.TypeLevelEdges(graph).Where(e => ids.Contains(e.Source) && ids.Contains(e.Target)))
        {
            links.Add(new XElement(Ns + "Link",
                new XAttribute("Source", edge.Source),
                new XAttribute("Target", edge.Target),
                new XAttribute("Category", edge.Kind),
                new XAttribute("Weight", edge.Weight)));
        }

        var categories = new XElement(Ns + "Categories",
            new XElement(Ns + "Category", new XAttribute("Id", "Contains"), new XAttribute("Label", "Contains"), new XAttribute("IsContainment", "True")));
        foreach (var (kind, color) in CategoryColors)
        {
            categories.Add(new XElement(Ns + "Category", new XAttribute("Id", kind), new XAttribute("Label", kind), new XAttribute("Background", color)));
        }

        foreach (var kind in EdgeKinds.All)
        {
            var category = new XElement(Ns + "Category", new XAttribute("Id", kind), new XAttribute("Label", kind));
            if (EdgeColors.TryGetValue(kind, out var color)) category.Add(new XAttribute("Stroke", color));
            categories.Add(category);
        }

        var properties = new XElement(Ns + "Properties",
            new XElement(Ns + "Property", new XAttribute("Id", "Reference"), new XAttribute("DataType", "System.String"), new XAttribute("IsReference", "True")),
            new XElement(Ns + "Property", new XAttribute("Id", "FullName"), new XAttribute("DataType", "System.String")),
            new XElement(Ns + "Property", new XAttribute("Id", "Weight"), new XAttribute("DataType", "System.Int32")));

        return new XDocument(new XDeclaration("1.0", "utf-8", null),
            new XElement(Ns + "DirectedGraph",
                new XAttribute("Title", graph.Source.Name),
                new XAttribute("GraphDirection", "LeftToRight"),
                new XAttribute("Layout", "Sugiyama"),
                nodes, links, categories, properties));
    }

    private static string Capitalize(string value) => char.ToUpperInvariant(value[0]) + value[1..];
}
