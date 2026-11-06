using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>
/// The class metrics of Lanza and Marinescu ("Object-Oriented Metrics in Practice"), from the map's
/// <c>accesses</c> edges: which attributes (fields and properties) each method reads or writes, its own class's or
/// others'. Classes are classes, structs and records at any level (a TypeScript class is a member of its file);
/// constants and static attributes are not data of an object, so they are left out.
/// </summary>
public sealed class ClassMetrics
{
    /// <param name="Wmc">Weighted methods per class: the summed complexity of its members.</param>
    /// <param name="Atfd">Access to foreign data: distinct attributes of other classes its members use.</param>
    /// <param name="Tcc">Tight class cohesion: the share of method pairs that use at least one attribute in common (1 with fewer than two methods).</param>
    public sealed record ClassStats(double Wmc, int Atfd, double Tcc, int Methods);

    /// <param name="Atfd">Distinct attributes of other classes the method uses.</param>
    /// <param name="Laa">Locality of attribute accesses: own attributes / all attributes it uses (1 when it uses none).</param>
    /// <param name="Fdp">Foreign data providers: classes it takes those attributes from.</param>
    /// <param name="Provider">The class it uses the most attributes of, when it uses foreign ones.</param>
    public sealed record MethodStats(int Atfd, double Laa, int Fdp, string? Provider, int OwnAttributes);

    private static readonly HashSet<string> ClassKinds = new(StringComparer.Ordinal) { NodeKinds.Class, NodeKinds.Struct, NodeKinds.Record, NodeKinds.RecordStruct };

    private readonly Dictionary<string, ClassStats> _classes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MethodStats> _methods = new(StringComparer.Ordinal);

    public ClassMetrics(GraphIndex index)
    {
        bool IsAttribute(GraphNode node) =>
            node.Kind is NodeKinds.Field or NodeKinds.Property && !node.External && node.Parent != null
            && node.Modifiers?.Any(m => m is "static" or "const") != true;

        foreach (var type in index.Graph.Nodes.Where(n => IsClass(n) && !n.External))
        {
            var foreignOfClass = new HashSet<string>(StringComparer.Ordinal);
            var ownByMethod = new List<HashSet<string>>();
            foreach (var member in index.Children(type.Id).Where(NodeLevels.IsMember))
            {
                var own = new HashSet<string>(StringComparer.Ordinal);
                var foreign = new Dictionary<string, string>(StringComparer.Ordinal); // attribute -> its class
                foreach (var edge in index.Outgoing(member.Id))
                {
                    if (edge.Kind != EdgeKinds.Accesses || index.Node(edge.Target) is not { } target || !IsAttribute(target)) continue;
                    if (target.Parent == type.Id) own.Add(target.Id);
                    else if (index.Node(target.Parent!) is { } owner && IsClass(owner)) foreign[target.Id] = owner.Id;
                }

                foreignOfClass.UnionWith(foreign.Keys);
                if (member.Kind is not (NodeKinds.Method or NodeKinds.Function) || member.Modifiers?.Contains("static") == true) continue;
                ownByMethod.Add(own);
                var total = own.Count + foreign.Count;
                var provider = foreign.Values.GroupBy(v => v, StringComparer.Ordinal).OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal).FirstOrDefault()?.Key;
                _methods[member.Id] = new MethodStats(foreign.Count, total == 0 ? 1 : (double)own.Count / total,
                    foreign.Values.Distinct(StringComparer.Ordinal).Count(), provider, own.Count);
            }

            var pairs = ownByMethod.Count * (ownByMethod.Count - 1) / 2;
            var connected = 0;
            for (var i = 0; i < ownByMethod.Count; i++)
            {
                for (var j = i + 1; j < ownByMethod.Count; j++)
                {
                    if (ownByMethod[i].Overlaps(ownByMethod[j])) connected++;
                }
            }

            _classes[type.Id] = new ClassStats(type.Metric("complexity"), foreignOfClass.Count, pairs == 0 ? 1 : (double)connected / pairs, ownByMethod.Count);
        }
    }

    /// <summary>Classes, structs and records, at whatever level their language puts them.</summary>
    public static bool IsClass(GraphNode node) => ClassKinds.Contains(node.Kind);

    public IEnumerable<KeyValuePair<string, ClassStats>> Classes => _classes;

    public ClassStats? Class(string id) => _classes.GetValueOrDefault(id);

    /// <summary>Instance methods of classes.</summary>
    public MethodStats? Method(string id) => _methods.GetValueOrDefault(id);
}
