namespace CodeMap.Analysis;

/// <summary>Tarjan's strongly connected components (iterative, so deep graphs cannot overflow the stack).</summary>
public static class CycleDetector
{
    public static List<List<string>> FindCycles(IReadOnlyDictionary<string, HashSet<string>> graph)
    {
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        var lowLink = new Dictionary<string, int>(StringComparer.Ordinal);
        var onStack = new HashSet<string>(StringComparer.Ordinal);
        var stack = new Stack<string>();
        var result = new List<List<string>>();
        var counter = 0;

        var nodes = graph.Keys.Concat(graph.Values.SelectMany(v => v)).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList();

        foreach (var start in nodes)
        {
            if (index.ContainsKey(start)) continue;

            var work = new Stack<(string Node, IEnumerator<string> Next)>();
            Enter(start);

            while (work.Count > 0)
            {
                var (node, next) = work.Peek();
                if (next.MoveNext())
                {
                    var child = next.Current;
                    if (!index.ContainsKey(child))
                    {
                        Enter(child);
                    }
                    else if (onStack.Contains(child))
                    {
                        lowLink[node] = Math.Min(lowLink[node], index[child]);
                    }

                    continue;
                }

                work.Pop();
                if (work.Count > 0)
                {
                    var parent = work.Peek().Node;
                    lowLink[parent] = Math.Min(lowLink[parent], lowLink[node]);
                }

                if (lowLink[node] != index[node]) continue;

                var component = new List<string>();
                string member;
                do
                {
                    member = stack.Pop();
                    onStack.Remove(member);
                    component.Add(member);
                } while (member != node);

                if (component.Count > 1)
                {
                    component.Sort(StringComparer.Ordinal);
                    result.Add(component);
                }
            }

            void Enter(string node)
            {
                index[node] = lowLink[node] = counter++;
                stack.Push(node);
                onStack.Add(node);
                var neighbours = graph.TryGetValue(node, out var set)
                    ? set.OrderBy(n => n, StringComparer.Ordinal).ToList()
                    : new List<string>();
                work.Push((node, neighbours.GetEnumerator()));
            }
        }

        return result;
    }
}
