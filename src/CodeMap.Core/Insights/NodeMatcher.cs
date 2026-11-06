using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>
/// Which node of one map is which node of another (before and after a change): by id, then a type moved to another
/// namespace (same kind and name, unique), then a renamed type (mostly the same members), then members under their
/// matched type, and a namespace renamed when most of its types went to one new namespace together.
/// </summary>
public sealed class NodeMatcher
{
    private readonly Dictionary<string, string> _toAfter = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _toBefore = new(StringComparer.Ordinal);

    public NodeMatcher(GraphIndex before, GraphIndex after)
    {
        var afterIds = after.Graph.Nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var node in before.Graph.Nodes.Where(n => afterIds.Contains(n.Id))) Pair(node.Id, node.Id);

        // Types moved to another namespace or file: the same kind and name (and arity), and only one such candidate.
        var unmatchedAfter = after.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && !_toBefore.ContainsKey(n.Id)).ToList();
        var byName = unmatchedAfter.GroupBy(n => (n.Kind, n.Name, n.Metric("typeParameters"))).ToDictionary(g => g.Key, g => g.ToList());
        var unmatchedBefore = before.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && !_toAfter.ContainsKey(n.Id)).ToList();
        var beforeByName = unmatchedBefore.GroupBy(n => (n.Kind, n.Name, n.Metric("typeParameters"))).ToDictionary(g => g.Key, g => g.Count());
        foreach (var node in unmatchedBefore)
        {
            var key = (node.Kind, node.Name, node.Metric("typeParameters"));
            if (beforeByName[key] == 1 && byName.TryGetValue(key, out var candidates) && candidates.Count == 1) Pair(node.Id, candidates[0].Id, moved: true);
        }

        // Renamed types: mostly the same member names.
        HashSet<string> Members(GraphIndex index, string id) => index.Children(id).Where(NodeLevels.IsMember).Select(m => m.Name).ToHashSet(StringComparer.Ordinal);
        var remainingAfter = after.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && !_toBefore.ContainsKey(n.Id)).Select(n => (Node: n, Members: Members(after, n.Id))).Where(x => x.Members.Count >= 2).ToList();
        var stillBefore = before.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && !_toAfter.ContainsKey(n.Id)).ToList();
        if ((double)stillBefore.Count * remainingAfter.Count > 4_000_000) stillBefore.Clear(); // two different code bases: nothing to rename
        foreach (var node in stillBefore)
        {
            var members = Members(before, node.Id);
            if (members.Count < 2) continue;
            var best = remainingAfter.Where(c => c.Node.Kind == node.Kind && !_toBefore.ContainsKey(c.Node.Id))
                .Select(c => (c.Node, Score: (double)c.Members.Intersect(members).Count() / c.Members.Union(members).Count()))
                .OrderByDescending(c => c.Score).ThenBy(c => c.Node.Id, StringComparer.Ordinal).FirstOrDefault();
            if (best.Node != null && best.Score >= 0.6) Pair(node.Id, best.Node.Id, renamed: true);
        }

        // Members of matched types: by kind and signature, then by name when unique.
        foreach (var (beforeType, afterType) in _toAfter.ToList())
        {
            if (beforeType == afterType || before.Node(beforeType) is not { } b || !NodeLevels.IsType(b)) continue;
            var afterMembers = after.Children(afterType).Where(m => NodeLevels.IsMember(m) && !_toBefore.ContainsKey(m.Id)).ToList();
            foreach (var member in before.Children(beforeType).Where(m => NodeLevels.IsMember(m) && !_toAfter.ContainsKey(m.Id)))
            {
                var match = afterMembers.FirstOrDefault(m => m.Kind == member.Kind && m.Signature == member.Signature && m.Name == member.Name && !_toBefore.ContainsKey(m.Id))
                            ?? (afterMembers.Count(m => m.Kind == member.Kind && m.Name == member.Name && !_toBefore.ContainsKey(m.Id)) == 1
                                ? afterMembers.First(m => m.Kind == member.Kind && m.Name == member.Name && !_toBefore.ContainsKey(m.Id)) : null);
                if (match != null) Pair(member.Id, match.Id);
            }
        }

        // Namespaces (folders) whose types moved together: renamed when 70% or more of them landed in one new namespace.
        var typesOf = before.Graph.Nodes.Where(NodeLevels.IsType).ToLookup(t => before.NamespaceOf(t.Id) ?? "", StringComparer.Ordinal);
        foreach (var ns in before.Graph.Nodes.Where(n => n.Kind == NodeKinds.Namespace && !_toAfter.ContainsKey(n.Id)))
        {
            var types = typesOf[ns.Id].ToList();
            if (types.Count == 0) continue;
            var landed = types.Select(t => _toAfter.TryGetValue(t.Id, out var a) ? after.NamespaceOf(a) : null).Where(a => a != null && !_toBefore.ContainsKey(a)).GroupBy(a => a!).OrderByDescending(g => g.Count()).FirstOrDefault();
            if (landed != null && landed.Count() >= 0.7 * types.Count) Pair(ns.Id, landed.Key, renamed: true);
        }
    }

    /// <summary>Types (and namespaces) found under another id: moved to another namespace or file.</summary>
    public List<(string Before, string After)> Moved { get; } = new();

    /// <summary>Types and namespaces matched by their content under a new name.</summary>
    public List<(string Before, string After)> Renamed { get; } = new();

    /// <summary>The id a node of the first map has in the second, or null when it is gone.</summary>
    public string? After(string beforeId) => _toAfter.GetValueOrDefault(beforeId);

    /// <summary>The id a node of the second map had in the first, or null when it is new.</summary>
    public string? Before(string afterId) => _toBefore.GetValueOrDefault(afterId);

    /// <summary>A before id in after's terms: its match, else itself.</summary>
    public string Translate(string beforeId) => _toAfter.GetValueOrDefault(beforeId) ?? beforeId;

    private void Pair(string before, string after, bool moved = false, bool renamed = false)
    {
        if (_toAfter.ContainsKey(before) || _toBefore.ContainsKey(after)) return;
        _toAfter[before] = after;
        _toBefore[after] = before;
        if (moved) Moved.Add((before, after));
        if (renamed) Renamed.Add((before, after));
    }
}
