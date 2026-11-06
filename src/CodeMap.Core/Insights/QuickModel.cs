using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>
/// A compact integer model of the type dependencies of a map, with the namespace and project of every type: enough to
/// tell in a few milliseconds whether moving types or inverting dependencies breaks cycles, so the proposal search can
/// try many candidates and simulate only the best for real.
/// </summary>
internal sealed class QuickModel
{
    /// <summary>A candidate change: types moved to other namespaces, type edges dropped, namespace edges added.</summary>
    public sealed class Change
    {
        public Dictionary<int, int> Moves { get; } = new();
        public HashSet<(int Source, int Target)> Removed { get; } = new();

        /// <summary>Namespace dependencies a change creates (an implementation that now points at an interface above it).</summary>
        public List<(int Source, int Target)> AddedNamespaceEdges { get; } = new();
    }

    /// <summary>How tangled the model is: nodes in cycles at each level (weighted into one number to compare candidates).</summary>
    public readonly record struct Tangle(int ProjectNodes, int NamespaceNodes, int TypeNodes)
    {
        public int Score => ProjectNodes * 100 + NamespaceNodes * 10 + TypeNodes;
    }

    private readonly Dictionary<string, int> _type = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _namespace = new(StringComparer.Ordinal);
    private readonly List<string> _namespaces = new();
    private readonly int[] _namespaceOf;
    private readonly int[] _projectOfNamespace;
    private readonly List<(int Source, int Target, int Weight, int Inheritance)> _edges = new();
    private readonly Dictionary<string, List<int>> _typesIn = new(StringComparer.Ordinal);

    public QuickModel(GraphIndex index)
    {
        var types = index.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External).ToList();
        foreach (var type in types) _type[type.Id] = _type.Count;
        var projects = new Dictionary<string, int>(StringComparer.Ordinal);
        var projectOfNs = new List<int>();
        int Namespace(string? id, string? project)
        {
            id ??= "(none):" + (project ?? "");
            if (_namespace.TryGetValue(id, out var n)) return n;
            _namespace[id] = n = _namespaces.Count;
            _namespaces.Add(id);
            var p = project ?? "(none)";
            if (!projects.TryGetValue(p, out var pi)) projects[p] = pi = projects.Count;
            projectOfNs.Add(pi);
            return n;
        }

        _namespaceOf = new int[types.Count];
        foreach (var type in types)
        {
            var i = _type[type.Id];
            _namespaceOf[i] = Namespace(index.NamespaceOf(type.Id), index.ProjectOf(type.Id));
            // Every container a type is in (namespaces, folders above it, its project) lists it.
            foreach (var container in index.AncestorsAndSelf(type).Skip(1).Where(a => !NodeLevels.IsMember(a)))
            {
                if (!_typesIn.TryGetValue(container.Id, out var list)) _typesIn[container.Id] = list = new List<int>();
                list.Add(i);
            }

            if (type.Project != null && !(index.Node(type.Project) is { } p && index.AncestorsAndSelf(type).Contains(p)))
            {
                if (!_typesIn.TryGetValue(type.Project, out var list)) _typesIn[type.Project] = list = new List<int>();
                list.Add(i);
            }
        }
        foreach (var ns in index.Graph.Nodes.Where(n => n.Kind == NodeKinds.Namespace && !n.External)) Namespace(ns.Id, index.ProjectOf(ns.Id));
        _projectOfNamespace = projectOfNs.ToArray();

        foreach (var d in index.Dependencies(NodeLevels.Type).Values)
        {
            if (!_type.TryGetValue(d.Source, out var s) || !_type.TryGetValue(d.Target, out var t)) continue;
            var inheritance = d.Kinds.Where(k => k.Key is EdgeKinds.Inherits or EdgeKinds.Extends).Sum(k => k.Value);
            _edges.Add((s, t, d.Weight, inheritance));
        }
    }

    public int? Type(string id) => _type.TryGetValue(id, out var i) ? i : null;

    public int? Namespace(string id) => _namespace.TryGetValue(id, out var i) ? i : null;

    public int NamespaceOfType(int type) => _namespaceOf[type];

    /// <summary>The types of a node: itself, or every type inside a namespace or project.</summary>
    public IEnumerable<int> TypesIn(GraphIndex index, string id)
    {
        if (_type.TryGetValue(id, out var t)) return new[] { t };
        return _typesIn.TryGetValue(id, out var list) ? list : Array.Empty<int>();
    }

    /// <summary>Type edges between two sets of types, with how many references they carry (inheritance apart).</summary>
    public IEnumerable<(int Source, int Target, int Weight, int Inheritance)> EdgesBetween(HashSet<int> sources, HashSet<int> targets) =>
        _edges.Where(e => sources.Contains(e.Source) && targets.Contains(e.Target));

    public Tangle Evaluate(Change? change = null)
    {
        int Ns(int type) => change != null && change.Moves.TryGetValue(type, out var moved) ? moved : _namespaceOf[type];
        var typeGraph = new Graph(_namespaceOf.Length);
        var nsGraph = new Graph(_namespaces.Count);
        var projectGraph = new Graph(_projectOfNamespace.Length == 0 ? 0 : _projectOfNamespace.Max() + 1);
        void Namespaces(int a, int b)
        {
            if (a == b) return;
            nsGraph.Add(a, b);
            var (pa, pb) = (_projectOfNamespace[a], _projectOfNamespace[b]);
            if (pa != pb) projectGraph.Add(pa, pb);
        }

        foreach (var (s, t, _, inheritance) in _edges)
        {
            if (change != null && inheritance == 0 && change.Removed.Contains((s, t))) continue;
            typeGraph.Add(s, t);
            Namespaces(Ns(s), Ns(t));
        }

        foreach (var (a, b) in change?.AddedNamespaceEdges ?? new List<(int, int)>()) Namespaces(a, b);
        return new Tangle(projectGraph.NodesInCycles(), nsGraph.NodesInCycles(), typeGraph.NodesInCycles());
    }

    /// <summary>A directed graph of ints with an iterative Tarjan: how many nodes are in strongly connected components of 2 or more.</summary>
    private sealed class Graph(int count)
    {
        private readonly List<int>?[] _out = new List<int>?[count];

        public void Add(int a, int b) => (_out[a] ??= new List<int>()).Add(b);

        public int NodesInCycles()
        {
            var n = _out.Length;
            var index = new int[n];
            var low = new int[n];
            var onStack = new bool[n];
            Array.Fill(index, -1);
            var stack = new Stack<int>();
            var work = new Stack<(int Node, int Next)>();
            var counter = 0;
            var inCycles = 0;
            for (var start = 0; start < n; start++)
            {
                if (index[start] >= 0 || _out[start] == null) continue;
                work.Push((start, 0));
                index[start] = low[start] = counter++;
                stack.Push(start);
                onStack[start] = true;
                while (work.Count > 0)
                {
                    var (v, next) = work.Pop();
                    var edges = _out[v];
                    if (edges != null && next < edges.Count)
                    {
                        work.Push((v, next + 1));
                        var w = edges[next];
                        if (index[w] < 0)
                        {
                            index[w] = low[w] = counter++;
                            stack.Push(w);
                            onStack[w] = true;
                            work.Push((w, 0));
                        }
                        else if (onStack[w])
                        {
                            low[v] = Math.Min(low[v], index[w]);
                        }

                        continue;
                    }

                    if (work.Count > 0) low[work.Peek().Node] = Math.Min(low[work.Peek().Node], low[v]);
                    if (low[v] != index[v]) continue;
                    var size = 0;
                    int x;
                    do
                    {
                        x = stack.Pop();
                        onStack[x] = false;
                        size++;
                    } while (x != v);

                    if (size > 1) inCycles += size;
                }
            }

            return inCycles;
        }
    }
}
