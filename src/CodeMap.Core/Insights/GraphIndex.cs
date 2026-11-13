using System.Collections.Concurrent;
using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>A place in the code: a path relative to the map's root and a line.</summary>
public sealed record CodeRef(string File, int Line)
{
    public override string ToString() => Line > 0 ? $"{File}:{Line}" : File;
}

/// <summary>What a name given by a person or an agent stands for: one node, or the candidates when it is ambiguous.</summary>
public sealed record Resolution(GraphNode? Node, IReadOnlyList<GraphNode> Candidates)
{
    public bool Found => Node != null;
}

/// <summary>
/// A dependency between two nodes of one level (types, namespaces or projects), rolled up from the edges between
/// their contents: how heavy it is, of which kinds, and the edges behind it with their place in the code.
/// </summary>
public sealed class Dependency
{
    public required string Source { get; init; }
    public required string Target { get; init; }

    /// <summary>Sum of the weights of the edges behind it (occurrences in code).</summary>
    public int Weight { get; internal set; }

    /// <summary>Weight by edge kind.</summary>
    public Dictionary<string, int> Kinds { get; } = new(StringComparer.Ordinal);

    /// <summary>The graph's own edges behind it (members, imports…), heaviest first after <see cref="GraphIndex.Dependencies"/>.</summary>
    public List<GraphEdge> Edges { get; } = new();
}

/// <summary>
/// Look-ups over a finished map that the insights, simulations and the MCP tools share: nodes by id and name,
/// the tree, edges in and out, and dependencies rolled up to a level with the code behind them. Built once per
/// graph; the graph must not change while it is used. Safe to use from several threads.
/// </summary>
public sealed class GraphIndex
{
    private static readonly IReadOnlyList<GraphNode> NoNodes = Array.Empty<GraphNode>();
    private static readonly IReadOnlyList<GraphEdge> NoEdges = Array.Empty<GraphEdge>();

    private readonly Dictionary<string, GraphNode> _byId;
    private readonly Dictionary<string, List<GraphNode>> _children = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<GraphEdge>> _outgoing = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<GraphEdge>> _incoming = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<(string, string), Dependency>> _dependencies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (ILookup<string, Dependency> Out, ILookup<string, Dependency> In)> _adjacency = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string?> _typeOf = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<CycleInfo, List<Dependency>>> _insideCycles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ILookup<string, GraphNode>> _typesIn = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly HashSet<string> _testProjects;
    private ILookup<string, GraphNode>? _byName;
    private ILookup<string, GraphNode>? _byFullName;

    public GraphIndex(CodeGraph graph)
    {
        Graph = graph;
        _byId = new Dictionary<string, GraphNode>(graph.Nodes.Count, StringComparer.Ordinal);
        foreach (var node in graph.Nodes) _byId.TryAdd(node.Id, node);
        foreach (var node in graph.Nodes.Where(n => n.Parent != null)) Add(_children, node.Parent!, node);
        foreach (var edge in graph.Edges)
        {
            Add(_outgoing, edge.Source, edge);
            Add(_incoming, edge.Target, edge);
        }

        _testProjects = graph.Nodes.Where(n => n.Kind == NodeKinds.Project && n.HasTag(Tags.TestProject)).Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
    }

    public CodeGraph Graph { get; }

    public GraphNode? Node(string id) => _byId.GetValueOrDefault(id);

    public IReadOnlyList<GraphNode> Children(string id) => _children.TryGetValue(id, out var list) ? list : NoNodes;

    public GraphNode? ParentOf(GraphNode node) => node.Parent != null ? Node(node.Parent) : null;

    /// <summary>The node and its ancestors, innermost first.</summary>
    public IEnumerable<GraphNode> AncestorsAndSelf(GraphNode node)
    {
        for (var current = node; current != null; current = ParentOf(current)) yield return current;
    }

    public IReadOnlyList<GraphEdge> Outgoing(string id) => _outgoing.TryGetValue(id, out var list) ? list : NoEdges;

    public IReadOnlyList<GraphEdge> Incoming(string id) => _incoming.TryGetValue(id, out var list) ? list : NoEdges;

    /// <summary>The type-level node a node is in: itself for a type, the innermost type around a member; null for containers.</summary>
    public string? TypeOf(string id)
    {
        return _typeOf.GetOrAdd(id, key =>
            Node(key) is { } node && AncestorsAndSelf(node).SkipWhile(NodeLevels.IsMember).FirstOrDefault() is { } owner && NodeLevels.IsType(owner) ? owner.Id : null);
    }

    /// <summary>The innermost namespace (folder) a node is in, itself included.</summary>
    public string? NamespaceOf(string id) => Node(id) is { } node ? AncestorsAndSelf(node).FirstOrDefault(n => n.Kind == NodeKinds.Namespace)?.Id : null;

    /// <summary>The project (package) a node belongs to, itself included.</summary>
    public string? ProjectOf(string id)
    {
        var node = Node(id);
        if (node == null) return null;
        if (node.Kind is NodeKinds.Project) return node.Id;
        return node.Project ?? AncestorsAndSelf(node).FirstOrDefault(n => n.Kind == NodeKinds.Project)?.Id;
    }

    /// <summary>The node of a level (project, namespace, type, member) that holds a node: what it counts as at that level.</summary>
    public string? ContainerOf(string id, string level) => level switch
    {
        NodeLevels.Project => ProjectOf(id),
        NodeLevels.Namespace => NamespaceOf(id),
        NodeLevels.Type => TypeOf(id),
        NodeLevels.Member => Node(id) is { } node && NodeLevels.IsMember(node) ? id : null,
        _ => throw new ArgumentException($"Unknown level '{level}': use project, namespace, type or member.", nameof(level)),
    };

    /// <summary>Test code: a test project, or a node tagged as a test (or inside one).</summary>
    public bool IsTest(GraphNode node) =>
        node.Project != null && _testProjects.Contains(node.Project) || AncestorsAndSelf(node).Any(n => n.HasTag(Tags.Test) || _testProjects.Contains(n.Id));

    /// <summary>Generated code: the node or what contains it is marked as generated.</summary>
    public bool IsGenerated(GraphNode node) => AncestorsAndSelf(node).Any(n => n.HasTag(Tags.Generated));

    /// <summary>Where a node is declared.</summary>
    public CodeRef? Where(GraphNode node) => node.Location is { } location ? new CodeRef(location.File, location.Line) : null;

    /// <summary>Where an edge is in the code: the line of its first occurrence when known, else the declaration of its source.</summary>
    public CodeRef? Where(GraphEdge edge)
    {
        var source = Node(edge.Source);
        var location = source?.Location ?? (source != null ? AncestorsAndSelf(source).Select(n => n.Location).FirstOrDefault(l => l != null) : null);
        if (location == null) return null;
        return new CodeRef(location.File, edge.Line > 0 ? edge.Line : location.Line);
    }

    /// <summary>
    /// Dependencies at a level: every edge that is a code dependency (not package references, git coupling or
    /// containment) between two different nodes of the level, internal ones only, rolled up with its weight.
    /// Computed once per level.
    /// </summary>
    public IReadOnlyDictionary<(string Source, string Target), Dependency> Dependencies(string level)
    {
        lock (_gate) return DependenciesLocked(level);
    }

    private Dictionary<(string, string), Dependency> DependenciesLocked(string level)
    {
        if (_dependencies.TryGetValue(level, out var cached)) return cached;
        var result = new Dictionary<(string, string), Dependency>();
        foreach (var edge in Graph.Edges)
        {
            if (!EdgeKinds.IsDependency(edge.Kind) || edge.Kind == EdgeKinds.PackageReference) continue;
            if (level != NodeLevels.Project && edge.Kind == EdgeKinds.ProjectReference) continue;
            var source = ContainerOf(edge.Source, level);
            var target = ContainerOf(edge.Target, level);
            if (source == null || target == null || source == target) continue;
            if (Node(source)!.External || Node(target)!.External) continue;
            if (!result.TryGetValue((source, target), out var dependency)) result[(source, target)] = dependency = new Dependency { Source = source, Target = target };
            dependency.Weight += edge.Weight;
            dependency.Kinds[edge.Kind] = dependency.Kinds.GetValueOrDefault(edge.Kind) + edge.Weight;
            dependency.Edges.Add(edge);
        }

        foreach (var dependency in result.Values) dependency.Edges.Sort((a, b) => b.Weight.CompareTo(a.Weight));
        _dependencies[level] = result;
        return result;
    }

    /// <summary>What a node depends on at a level (it must be a node of that level).</summary>
    public IEnumerable<Dependency> DependenciesOf(string id, string level) => Adjacency(level).Out[id];

    /// <summary>What depends on a node at a level.</summary>
    public IEnumerable<Dependency> DependentsOf(string id, string level) => Adjacency(level).In[id];

    /// <summary>
    /// The dependencies inside a cycle of this graph (<see cref="AnalysisResult.Cycles"/>), in the order of
    /// <see cref="Dependencies"/>; null for a cycle that is not this graph's. All cycles of a level are worked out
    /// in one pass over its dependencies (asking per cycle looked at every dependency for every cycle).
    /// </summary>
    public IReadOnlyList<Dependency>? Inside(CycleInfo cycle)
    {
        lock (_gate)
        {
            if (!_insideCycles.TryGetValue(cycle.Level, out var byCycle))
            {
                byCycle = new Dictionary<CycleInfo, List<Dependency>>(ReferenceEqualityComparer.Instance);
                var cycleOf = new Dictionary<string, CycleInfo>(StringComparer.Ordinal);
                foreach (var other in Graph.Analysis.Cycles)
                {
                    if (other.Level != cycle.Level) continue;
                    byCycle[other] = new List<Dependency>();
                    foreach (var id in other.Nodes) cycleOf[id] = other;
                }

                foreach (var dependency in DependenciesLocked(cycle.Level).Values)
                {
                    if (cycleOf.TryGetValue(dependency.Source, out var from) && cycleOf.TryGetValue(dependency.Target, out var to) && ReferenceEquals(from, to))
                        byCycle[from].Add(dependency);
                }

                _insideCycles[cycle.Level] = byCycle;
            }

            return byCycle.GetValueOrDefault(cycle);
        }
    }

    /// <summary>The types a project or namespace holds (in the order of the graph's nodes), from one pass over the nodes per level.</summary>
    public IEnumerable<GraphNode> TypesIn(string container, string level)
    {
        ILookup<string, GraphNode>? lookup;
        lock (_gate) _typesIn.TryGetValue(level, out lookup);
        if (lookup == null)
        {
            lookup = Graph.Nodes.Where(NodeLevels.IsType).Select(n => (Node: n, In: ContainerOf(n.Id, level))).Where(x => x.In != null).ToLookup(x => x.In!, x => x.Node, StringComparer.Ordinal);
            lock (_gate) _typesIn[level] = lookup;
        }

        return lookup[container];
    }

    /// <summary>The dependency between two nodes of one level, if there is one.</summary>
    public Dependency? DependencyBetween(string source, string target, string level) => Dependencies(level).GetValueOrDefault((source, target));

    /// <summary>
    /// The node a name stands for: an id, a full name, a name, or the end of a full name (<c>Orders.OrderService</c>);
    /// code in the solution comes before external code. Several matches give no node and up to 10 candidates.
    /// </summary>
    public Resolution Resolve(string query, string? level = null)
    {
        query = query.Trim();
        if (query.Length == 0) return new Resolution(null, NoNodes);
        if (Node(query) is { } exact && Fits(exact)) return new Resolution(exact, new[] { exact });

        lock (_gate)
        {
            _byFullName ??= Graph.Nodes.Where(n => n.FullName != null).ToLookup(n => n.FullName!, StringComparer.Ordinal);
            _byName ??= Graph.Nodes.ToLookup(n => n.Name, StringComparer.Ordinal);
        }

        IEnumerable<GraphNode>[] tiers =
        {
            _byFullName[query],
            _byName[query],
            Graph.Nodes.Where(n => n.FullName != null && n.FullName.EndsWith("." + query, StringComparison.Ordinal)),
            Graph.Nodes.Where(n => string.Equals(n.Name, query, StringComparison.OrdinalIgnoreCase)
                                   || n.FullName != null && n.FullName.EndsWith("." + query, StringComparison.OrdinalIgnoreCase)),
        };

        foreach (var tier in tiers)
        {
            var matches = tier.Where(Fits).ToList();
            if (matches.Count == 0) continue;
            var own = matches.Where(n => !n.External).ToList();
            if (own.Count > 0) matches = own;
            if (matches.Count == 1) return new Resolution(matches[0], matches);

            // A type and its namesake constructor, or a partial declaration: the outermost one is meant.
            var outer = matches.Where(m => !matches.Any(o => o != m && AncestorsAndSelf(m).Skip(1).Contains(o))).ToList();
            if (outer.Count == 1) return new Resolution(outer[0], matches.Take(10).ToList());
            return new Resolution(null, matches.OrderBy(n => n.FullName ?? n.Id, StringComparer.Ordinal).Take(10).ToList());
        }

        return new Resolution(null, NoNodes);

        bool Fits(GraphNode node) => level == null || NodeLevels.Of(node) == level;
    }

    private (ILookup<string, Dependency> Out, ILookup<string, Dependency> In) Adjacency(string level)
    {
        lock (_gate)
        {
            if (_adjacency.TryGetValue(level, out var cached)) return cached;
            var all = DependenciesLocked(level).Values.ToList();
            return _adjacency[level] = (all.ToLookup(d => d.Source, StringComparer.Ordinal), all.ToLookup(d => d.Target, StringComparer.Ordinal));
        }
    }

    private static void Add<T>(Dictionary<string, List<T>> map, string key, T value)
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = new List<T>();
        list.Add(value);
    }
}
