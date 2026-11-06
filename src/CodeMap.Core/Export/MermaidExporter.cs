using System.Globalization;
using System.Text;
using CodeMap.Analysis;
using CodeMap.Insights;
using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>
/// Mermaid diagrams of a map for text-only readers (an AI agent, a pull request, a wiki): dependencies at a level,
/// the layers, a cycle with its cut, a class with its neighbours, the DI wiring. Every diagram keeps to a maximum
/// number of nodes; what does not fit is counted in a note.
/// </summary>
public static class MermaidExporter
{
    /// <summary>
    /// Dependencies between nodes of a level (projects, namespaces, types): around <paramref name="focus"/> (the nodes
    /// and their direct neighbours) or the most coupled ones. Upward and cyclic dependencies are red.
    /// </summary>
    public static string Dependencies(GraphIndex index, string level, IReadOnlyCollection<string>? focus = null, int maxNodes = 40)
    {
        var deps = index.Dependencies(level).Values.ToList();
        var chosen = new List<string>();
        if (focus is { Count: > 0 })
        {
            chosen.AddRange(focus.Where(id => index.Node(id) != null));
            var neighbours = deps.Where(d => focus.Contains(d.Source) || focus.Contains(d.Target))
                .OrderByDescending(d => d.Weight)
                .SelectMany(d => new[] { d.Source, d.Target });
            chosen.AddRange(neighbours);
        }
        else
        {
            var weight = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var d in deps)
            {
                weight[d.Source] = weight.GetValueOrDefault(d.Source) + d.Weight;
                weight[d.Target] = weight.GetValueOrDefault(d.Target) + d.Weight;
            }

            var units = index.Graph.Nodes.Where(n => NodeLevels.Of(n) == level && !n.External && (level != NodeLevels.Type || weight.ContainsKey(n.Id))).Select(n => n.Id);
            chosen.AddRange(units.OrderByDescending(id => weight.GetValueOrDefault(id)).ThenBy(id => id, StringComparer.Ordinal));
        }

        var all = chosen.Distinct(StringComparer.Ordinal).ToList();
        var shown = all.Take(maxNodes).ToList();
        var set = shown.ToHashSet(StringComparer.Ordinal);
        var red = Upward(index, level);
        var diagram = new Diagram("flowchart LR");
        foreach (var id in shown) diagram.Node(id, Label(index, id), focus?.Contains(id) == true ? "focus" : null);
        foreach (var d in deps.Where(d => set.Contains(d.Source) && set.Contains(d.Target)).OrderByDescending(d => d.Weight).ThenBy(d => d.Source, StringComparer.Ordinal).ThenBy(d => d.Target, StringComparer.Ordinal))
        {
            diagram.Edge(d.Source, d.Target, d.Weight.ToString(CultureInfo.InvariantCulture), red.Contains((d.Source, d.Target)) ? "red" : null);
        }

        if (all.Count > shown.Count) diagram.Note($"{all.Count - shown.Count} more not shown");
        return diagram.ToString();
    }

    /// <summary>The computed layers of a level (top first) with the upward dependencies that break them in red.</summary>
    public static string Layers(GraphIndex index, string level = NodeLevels.Namespace, int maxNodes = 40)
    {
        var info = index.Graph.Analysis.Layers.FirstOrDefault(l => l.Level == level);
        var diagram = new Diagram("flowchart TB");
        if (info == null)
        {
            diagram.Note($"no layers at the {level} level (fewer than two {level}s)");
            return diagram.ToString();
        }

        var shown = new HashSet<string>(StringComparer.Ordinal);
        var hidden = 0;
        for (var i = info.Layers.Count - 1; i >= 0; i--)
        {
            var members = info.Layers[i];
            var take = members.Take(Math.Max(1, maxNodes - shown.Count)).Where(_ => shown.Count < maxNodes).ToList();
            hidden += members.Count - take.Count;
            if (take.Count == 0) continue;
            diagram.Subgraph($"layer{i}", $"Layer {i}{(i == info.Layers.Count - 1 ? " (top)" : i == 0 ? " (bottom)" : "")}", take.Select(id => (id, Label(index, id))));
            shown.UnionWith(take);
        }

        foreach (var d in index.Dependencies(level).Values.Where(d => shown.Contains(d.Source) && shown.Contains(d.Target)).OrderByDescending(d => d.Weight).Take(120))
        {
            var upward = info.Upward.Any(u => u.Source == d.Source && u.Target == d.Target);
            diagram.Edge(d.Source, d.Target, upward ? $"{d.Weight} up" : null, upward ? "red" : null);
        }

        if (hidden > 0) diagram.Note($"{hidden} more not shown");
        return diagram.ToString();
    }

    /// <summary>One cycle: its nodes, the dependencies between them, and the cheapest cut in red (dashed).</summary>
    public static string Cycle(GraphIndex index, IReadOnlyCollection<string> nodes, string level, int maxNodes = 40)
    {
        var set = nodes.Take(maxNodes).ToHashSet(StringComparer.Ordinal);
        var inside = index.Dependencies(level).Values.Where(d => set.Contains(d.Source) && set.Contains(d.Target)).ToList();
        var cut = Layering.Compute(set, inside.Select(d => (d.Source, d.Target, d.Weight))).Upward.Select(u => (u.Source, u.Target)).ToHashSet();
        var diagram = new Diagram("flowchart LR");
        foreach (var id in set.OrderBy(id => id, StringComparer.Ordinal)) diagram.Node(id, Label(index, id));
        foreach (var d in inside.OrderByDescending(d => d.Weight).ThenBy(d => d.Source, StringComparer.Ordinal))
        {
            var isCut = cut.Contains((d.Source, d.Target));
            diagram.Edge(d.Source, d.Target, isCut ? $"{d.Weight} cut" : d.Weight.ToString(CultureInfo.InvariantCulture), isCut ? "cut" : null);
        }

        if (nodes.Count > set.Count) diagram.Note($"{nodes.Count - set.Count} more not shown");
        return diagram.ToString();
    }

    /// <summary>A class diagram of a type: its members, base types and interfaces, and the types it uses or is used by.</summary>
    public static string Class(GraphIndex index, string typeId, int maxMembers = 15, int maxNeighbours = 12)
    {
        var type = index.Node(typeId) ?? throw new ArgumentException($"No node {typeId}.", nameof(typeId));
        var sb = new StringBuilder("classDiagram\n");
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        string Id(string id)
        {
            if (!names.TryGetValue(id, out var name)) names[id] = name = "C" + names.Count.ToString(CultureInfo.InvariantCulture);
            return name;
        }

        string ClassName(string id) => Escape(index.Node(id)?.Name ?? id).Replace(' ', '_');
        void Declare(string id, IEnumerable<string>? lines = null, string? stereotype = null)
        {
            sb.Append($"    class {Id(id)}[\"{ClassName(id)}\"]");
            var body = lines?.ToList();
            if (body is { Count: > 0 } || stereotype != null)
            {
                sb.Append(" {\n");
                if (stereotype != null) sb.Append($"        <<{stereotype}>>\n");
                foreach (var line in body ?? new List<string>()) sb.Append("        ").Append(line).Append('\n');
                sb.Append("    }");
            }

            sb.Append('\n');
        }

        var members = index.Children(typeId).Where(NodeLevels.IsMember).ToList();
        string Visibility(GraphNode m) => m.Accessibility switch { "public" => "+", "private" => "-", "protected" => "#", _ => "~" };
        var memberLines = members.Take(maxMembers).Select(m => $"{Visibility(m)}{Escape(m.Name)}{(m.Kind is NodeKinds.Method or NodeKinds.Constructor or NodeKinds.Function ? "()" : "")}").ToList();
        if (members.Count > maxMembers) memberLines.Add($"… {members.Count - maxMembers} more");
        Declare(typeId, memberLines, type.Kind == NodeKinds.Interface ? "interface" : type.Modifiers?.Contains("abstract") == true ? "abstract" : null);

        var relations = new List<string>();
        foreach (var edge in index.Outgoing(typeId).Where(e => e.Kind is EdgeKinds.Inherits or EdgeKinds.Implements))
        {
            if (index.Node(edge.Target) is not { } target) continue;
            Declare(target.Id, stereotype: target.Kind == NodeKinds.Interface ? "interface" : null);
            relations.Add($"    {Id(target.Id)} <|{(edge.Kind == EdgeKinds.Implements ? ".." : "--")} {Id(typeId)}");
        }

        var uses = index.DependenciesOf(typeId, NodeLevels.Type).Where(d => !names.ContainsKey(d.Target)).OrderByDescending(d => d.Weight).Take(maxNeighbours).ToList();
        foreach (var d in uses)
        {
            Declare(d.Target);
            relations.Add($"    {Id(typeId)} --> {Id(d.Target)} : {d.Weight}");
        }

        var usedBy = index.DependentsOf(typeId, NodeLevels.Type).Where(d => !names.ContainsKey(d.Source)).OrderByDescending(d => d.Weight).Take(maxNeighbours).ToList();
        foreach (var d in usedBy)
        {
            Declare(d.Source);
            relations.Add($"    {Id(d.Source)} --> {Id(typeId)} : {d.Weight}");
        }

        foreach (var line in relations) sb.Append(line).Append('\n');
        return sb.ToString();
    }

    /// <summary>The DI wiring: consumers to the implementations they get, with lifetimes; issues in red.</summary>
    public static string Di(GraphIndex index, IReadOnlyCollection<string>? focus = null, int maxNodes = 40)
    {
        var di = index.Graph.Analysis.Di;
        var diagram = new Diagram("flowchart LR");
        if (di == null)
        {
            diagram.Note("no dependency injection found");
            return diagram.ToString();
        }

        var links = di.Dependencies
            .SelectMany(d => d.Implementations.Count > 0 ? d.Implementations.Select(i => (d.Consumer, Target: i, d.Lifetime)) : new[] { (d.Consumer, Target: d.Service, Lifetime: (string?)"unregistered") })
            .Where(l => focus is not { Count: > 0 } || focus.Contains(l.Consumer) || focus.Contains(l.Target))
            .Distinct()
            .ToList();
        var issues = di.Issues.Select(i => (i.Consumer, i.Service)).ToHashSet();
        var lifetimeOf = di.Registrations.Where(r => r.Implementation != null).GroupBy(r => r.Implementation!, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Last().Effective ?? g.Last().Lifetime, StringComparer.Ordinal);
        var nodes = links.SelectMany(l => new[] { l.Consumer, l.Target }).Distinct(StringComparer.Ordinal).ToList();
        var shown = nodes.Take(maxNodes).ToHashSet(StringComparer.Ordinal);
        foreach (var id in nodes.Where(shown.Contains))
        {
            var lifetime = lifetimeOf.GetValueOrDefault(id);
            diagram.Node(id, Label(index, id) + (lifetime != null ? $" ({lifetime})" : ""), lifetime);
        }

        foreach (var (consumer, target, lifetime) in links.Where(l => shown.Contains(l.Consumer) && shown.Contains(l.Target)))
        {
            var problem = issues.Contains((consumer, target)) || issues.Any(i => i.Consumer == consumer && di.Dependencies.Any(d => d.Consumer == consumer && d.Service == i.Service && d.Implementations.Contains(target)));
            diagram.Edge(consumer, target, lifetime, problem || lifetime == "unregistered" ? "red" : null);
        }

        if (nodes.Count > shown.Count) diagram.Note($"{nodes.Count - shown.Count} more not shown");
        return diagram.ToString();
    }

    private static HashSet<(string, string)> Upward(GraphIndex index, string level)
    {
        var result = new HashSet<(string, string)>();
        foreach (var edge in index.Graph.Analysis.Layers.FirstOrDefault(l => l.Level == level)?.Upward ?? new List<GraphEdge>()) result.Add((edge.Source, edge.Target));
        if (level == NodeLevels.Type)
        {
            foreach (var cycle in index.Graph.Analysis.Cycles.Where(c => c.Level == level))
            {
                var set = cycle.Nodes.ToHashSet(StringComparer.Ordinal);
                foreach (var d in index.Dependencies(level).Values.Where(d => set.Contains(d.Source) && set.Contains(d.Target))) result.Add((d.Source, d.Target));
            }
        }

        return result;
    }

    private static string Label(GraphIndex index, string id) => index.Node(id) is { } node ? node.Name.StartsWith('(') ? node.FullName ?? node.Name : node.Name : id;

    /// <summary>Mermaid text: what a label may not contain is written as an entity.</summary>
    internal static string Escape(string text) => text.Replace("\"", "#quot;").Replace("<", "#lt;").Replace(">", "#gt;");

    /// <summary>A flowchart under construction: short node ids, labels, edges, styles.</summary>
    private sealed class Diagram
    {
        private readonly StringBuilder _sb = new();
        private readonly Dictionary<string, string> _ids = new(StringComparer.Ordinal);
        private readonly List<string> _edgeStyles = new();
        private readonly Dictionary<string, List<string>> _classes = new(StringComparer.Ordinal);
        private int _edges;

        public Diagram(string header) => _sb.Append(header).Append('\n');

        private string Id(string id)
        {
            if (!_ids.TryGetValue(id, out var shortId)) _ids[id] = shortId = "n" + _ids.Count.ToString(CultureInfo.InvariantCulture);
            return shortId;
        }

        public void Node(string id, string label, string? cls = null)
        {
            _sb.Append($"    {Id(id)}[\"{Escape(label)}\"]\n");
            if (cls == null) return;
            if (!_classes.TryGetValue(cls, out var list)) _classes[cls] = list = new List<string>();
            list.Add(Id(id));
        }

        public void Subgraph(string id, string title, IEnumerable<(string Id, string Label)> nodes)
        {
            _sb.Append($"    subgraph {id}[\"{Escape(title)}\"]\n");
            foreach (var (node, label) in nodes) _sb.Append($"        {Id(node)}[\"{Escape(label)}\"]\n");
            _sb.Append("    end\n");
        }

        public void Edge(string source, string target, string? label, string? style)
        {
            var arrow = style == "cut" ? "-.->" : "-->";
            _sb.Append(label != null ? $"    {Id(source)} {arrow}|\"{Escape(label)}\"| {Id(target)}\n" : $"    {Id(source)} {arrow} {Id(target)}\n");
            if (style is "red" or "cut") _edgeStyles.Add(_edges.ToString(CultureInfo.InvariantCulture));
            _edges++;
        }

        public void Note(string text) => _sb.Append($"    note[\"{Escape(text)}\"]\n    style note fill:none,stroke-dasharray:3 3\n");

        public override string ToString()
        {
            var sb = new StringBuilder(_sb.ToString());
            if (_edgeStyles.Count > 0) sb.Append($"    linkStyle {string.Join(",", _edgeStyles)} stroke:#d33,stroke-width:2px\n");
            foreach (var (cls, ids) in _classes)
            {
                var color = cls switch { "focus" => "#fde68a", Tags.DiSingleton => "#c7d2fe", Tags.DiScoped => "#bbf7d0", Tags.DiTransient => "#e5e7eb", _ => "#f3f4f6" };
                sb.Append($"    classDef {cls.Replace('-', '_')} fill:{color}\n    class {string.Join(",", ids)} {cls.Replace('-', '_')}\n");
            }

            return sb.ToString();
        }
    }
}
