using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>
/// Puts a dependency graph into layers so that dependencies point down. Cycles make that impossible,
/// so first a small set of edges is chosen to point "up" (greedy feedback arc set, Eades–Lin–Smyth,
/// weighted so that the heaviest dependencies keep pointing down). Those upward edges are the ones
/// to cut to get a clean, acyclic architecture.
/// </summary>
public static class Layering
{
    public sealed record Result(List<List<string>> Layers, List<GraphEdge> Upward, Dictionary<string, int> LayerOf);

    /// <param name="nodes">Every node to place (isolated nodes end up in the bottom layer).</param>
    /// <param name="edges">source depends on target, with a weight.</param>
    public static Result Compute(IEnumerable<string> nodes, IEnumerable<(string Source, string Target, int Weight)> edges)
    {
        var all = new SortedSet<string>(nodes, StringComparer.Ordinal);
        var outgoing = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
        var incoming = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
        foreach (var node in all)
        {
            outgoing[node] = new Dictionary<string, int>(StringComparer.Ordinal);
            incoming[node] = new Dictionary<string, int>(StringComparer.Ordinal);
        }

        foreach (var (source, target, weight) in edges)
        {
            if (source == target || !all.Contains(source) || !all.Contains(target)) continue;
            outgoing[source][target] = outgoing[source].GetValueOrDefault(target) + weight;
            incoming[target][source] = incoming[target].GetValueOrDefault(source) + weight;
        }

        var order = Order(all, outgoing, incoming);
        var position = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < order.Count; i++) position[order[i]] = i;

        // Forward edges (earlier → later in the order) form a DAG: longest path from the bottom.
        var layer = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = order.Count - 1; i >= 0; i--)
        {
            var node = order[i];
            var height = 0;
            foreach (var target in outgoing[node].Keys)
            {
                if (position[target] > i) height = Math.Max(height, layer[target] + 1);
            }

            layer[node] = height;
        }

        // Pull-up: a node that only serves high layers sits right below its lowest user instead of at the bottom.
        foreach (var node in order.Where(n => incoming[n].Count > 0))
        {
            var lowestUser = int.MaxValue;
            foreach (var source in incoming[node].Keys)
            {
                if (position[source] < position[node]) lowestUser = Math.Min(lowestUser, layer[source]);
            }

            if (lowestUser != int.MaxValue && lowestUser - 1 > layer[node]) layer[node] = lowestUser - 1;
        }

        // Every cycle has at least one edge that cannot point down; those are what we report.
        var upward = new List<GraphEdge>();
        foreach (var (source, targets) in outgoing)
        {
            foreach (var (target, weight) in targets)
            {
                if (layer[target] >= layer[source]) upward.Add(new GraphEdge { Source = source, Target = target, Kind = "upward", Weight = weight });
            }
        }

        var layers = layer
            .GroupBy(p => p.Value)
            .OrderBy(g => g.Key)
            .Select(g => g.Select(p => p.Key).OrderBy(id => id, StringComparer.Ordinal).ToList())
            .ToList();
        upward.Sort((a, b) =>
        {
            var c = b.Weight.CompareTo(a.Weight);
            return c != 0 ? c : string.CompareOrdinal(a.Source + a.Target, b.Source + b.Target);
        });
        return new Result(layers, upward, layer);
    }

    /// <summary>
    /// Orders nodes so that dependencies mostly point forward: strongly connected components in
    /// topological order (users first), and inside each component the greedy heuristic.
    /// </summary>
    private static List<string> Order(SortedSet<string> nodes, Dictionary<string, Dictionary<string, int>> outgoing,
        Dictionary<string, Dictionary<string, int>> incoming)
    {
        var sets = outgoing.ToDictionary(p => p.Key, p => p.Value.Keys.ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        var component = new Dictionary<string, int>(StringComparer.Ordinal);
        var members = new List<List<string>>();
        foreach (var cycle in CycleDetector.FindCycles(sets))
        {
            foreach (var node in cycle) component[node] = members.Count;
            members.Add(cycle);
        }

        foreach (var node in nodes.Where(n => !component.ContainsKey(n)))
        {
            component[node] = members.Count;
            members.Add(new List<string> { node });
        }

        // Kahn on the condensation; ties broken by name for stable output.
        var indegree = new int[members.Count];
        var successors = new HashSet<int>[members.Count];
        for (var i = 0; i < members.Count; i++) successors[i] = new HashSet<int>();
        foreach (var (source, targets) in outgoing)
        {
            foreach (var target in targets.Keys)
            {
                var (a, b) = (component[source], component[target]);
                if (a != b && successors[a].Add(b)) indegree[b]++;
            }
        }

        var ready = new SortedSet<(string Name, int Index)>(Enumerable.Range(0, members.Count).Where(i => indegree[i] == 0).Select(i => (members[i].Min(StringComparer.Ordinal)!, i)));
        var order = new List<string>();
        while (ready.Count > 0)
        {
            var next = ready.Min;
            ready.Remove(next);
            var group = members[next.Index];
            order.AddRange(group.Count == 1 ? group : GreedyOrder(new SortedSet<string>(group, StringComparer.Ordinal), outgoing, incoming));
            foreach (var successor in successors[next.Index])
            {
                if (--indegree[successor] == 0) ready.Add((members[successor].Min(StringComparer.Ordinal)!, successor));
            }
        }

        return order;
    }

    /// <summary>Eades–Lin–Smyth: peel sinks to the back, sources to the front, otherwise the node with the largest out-in surplus.</summary>
    private static List<string> GreedyOrder(SortedSet<string> nodes, Dictionary<string, Dictionary<string, int>> outgoing,
        Dictionary<string, Dictionary<string, int>> incoming)
    {
        var remaining = new SortedSet<string>(nodes, StringComparer.Ordinal);
        var outWeight = nodes.ToDictionary(n => n, n => outgoing[n].Where(t => nodes.Contains(t.Key)).Sum(t => t.Value), StringComparer.Ordinal);
        var inWeight = nodes.ToDictionary(n => n, n => incoming[n].Where(t => nodes.Contains(t.Key)).Sum(t => t.Value), StringComparer.Ordinal);
        var front = new List<string>();
        var back = new List<string>();

        void Remove(string node)
        {
            remaining.Remove(node);
            foreach (var (target, weight) in outgoing[node]) if (remaining.Contains(target)) inWeight[target] -= weight;
            foreach (var (source, weight) in incoming[node]) if (remaining.Contains(source)) outWeight[source] -= weight;
        }


        while (remaining.Count > 0)
        {
            bool changed;
            do
            {
                changed = false;
                foreach (var sink in remaining.Where(n => outWeight[n] == 0).ToList())
                {
                    if (!remaining.Contains(sink) || outWeight[sink] != 0) continue;
                    back.Add(sink);
                    Remove(sink);
                    changed = true;
                }

                foreach (var source in remaining.Where(n => inWeight[n] == 0).ToList())
                {
                    if (!remaining.Contains(source) || inWeight[source] != 0) continue;
                    front.Add(source);
                    Remove(source);
                    changed = true;
                }
            } while (changed && remaining.Count > 0);

            if (remaining.Count == 0) break;
            var best = remaining.MaxBy(n => outWeight[n] - inWeight[n])!;
            front.Add(best);
            Remove(best);
        }

        back.Reverse();
        front.AddRange(back);
        return front;
    }

    /// <summary>Layers the namespaces and projects of a graph and stores them in <see cref="AnalysisResult.Layers"/>.</summary>
    internal static void Analyze(CodeGraph graph)
    {
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);

        string? Ancestor(string id, string kind)
        {
            for (var node = byId.GetValueOrDefault(id); node != null; node = node.Parent != null ? byId.GetValueOrDefault(node.Parent) : null)
            {
                if (node.Kind == kind) return node.Id;
            }

            return null;
        }

        foreach (var (level, kind) in new[] { ("project", NodeKinds.Project), ("namespace", NodeKinds.Namespace) })
        {
            var units = graph.Nodes.Where(n => n.Kind == kind && !n.External).Select(n => n.Id).ToList();
            if (units.Count < 2) continue;
            var weights = new Dictionary<(string, string), int>();
            foreach (var edge in graph.Edges)
            {
                if (!EdgeKinds.IsDependency(edge.Kind) || edge.Kind == EdgeKinds.PackageReference) continue;
                var source = Ancestor(edge.Source, kind);
                var target = Ancestor(edge.Target, kind);
                if (source == null || target == null || source == target) continue;
                weights[(source, target)] = weights.GetValueOrDefault((source, target)) + edge.Weight;
            }

            var result = Compute(units, weights.Select(w => (w.Key.Item1, w.Key.Item2, w.Value)));
            graph.Analysis.Layers.Add(new LayeringInfo { Level = level, Layers = result.Layers, Upward = result.Upward });
        }
    }
}
