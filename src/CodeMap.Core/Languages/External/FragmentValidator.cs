using CodeMap.Model;

namespace CodeMap.Languages.External;

/// <summary>
/// Checks what a plugin wrote before it joins the map: the format, ids in the plugin's own prefix, levels, that
/// parents and edges point at nodes that exist, locations relative to the root. What does not fit is dropped
/// and summed up in a warning instead of failing the analysis.
/// </summary>
public static class FragmentValidator
{
    public static CodeGraph Validate(CodeGraph graph, PluginManifest plugin, string root)
    {
        if (graph.Format != CodeGraph.FormatName || !graph.Version.StartsWith("1.", StringComparison.Ordinal))
        {
            throw new InvalidDataException($"{plugin.Name} wrote a '{graph.Format}' document version {graph.Version}; CodeMap reads codemap 1.x.");
        }

        var problems = new List<string>();
        void Count(int n, string what)
        {
            if (n > 0) problems.Add($"{n} {what}");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var nodes = new List<GraphNode>();
        int foreign = 0, duplicates = 0, levels = 0, locations = 0;
        foreach (var node in graph.Nodes)
        {
            if (!node.Id.StartsWith(plugin.IdPrefix, StringComparison.Ordinal)) { foreign++; continue; }
            if (!ids.Add(node.Id)) { duplicates++; continue; }
            if (node.Level != null && !NodeLevels.All.Contains(node.Level)) { node.Level = null; levels++; }
            if (node.Location != null && (node.Location = Relative(node.Location, root)) == null) locations++;
            node.ExtraLocations = node.ExtraLocations?.Select(l => Relative(l, root)).Where(l => l != null).Select(l => l!).ToList();
            if (node.ExtraLocations is { Count: 0 }) node.ExtraLocations = null;
            nodes.Add(node);
        }

        int parents = 0;
        foreach (var node in nodes)
        {
            if (node.Parent != null && !ids.Contains(node.Parent)) { node.Parent = null; parents++; }
            if (node.Project != null && !ids.Contains(node.Project)) node.Project = null;
        }

        // Parents form a tree: a node that is its own ancestor (itself, or A → B → A) would send the analysis
        // round in circles. Each cycle is cut at the node where the walk comes back to.
        var byId = nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        var settled = new HashSet<string>(StringComparer.Ordinal);
        int cycles = 0;
        foreach (var start in nodes)
        {
            var path = new HashSet<string>(StringComparer.Ordinal);
            for (var current = start; current != null && !settled.Contains(current.Id); current = current.Parent != null ? byId[current.Parent] : null)
            {
                if (path.Add(current.Id)) continue;
                current.Parent = null; // back where the walk has been: cut here
                cycles++;
                break;
            }

            settled.UnionWith(path);
        }

        var edges = graph.Edges.Where(e => ids.Contains(e.Source) && ids.Contains(e.Target) && !string.IsNullOrEmpty(e.Kind)).ToList();
        foreach (var edge in edges) edge.Weight = Math.Max(1, edge.Weight);
        var danglingEdges = graph.Edges.Count - edges.Count;

        if (graph.Analysis.Di is { } di)
        {
            var registrations = di.Registrations.Count;
            di.Registrations = di.Registrations.Where(r => r.External || ids.Contains(r.Service)).ToList();
            foreach (var registration in di.Registrations)
            {
                if (registration.Implementation != null && !ids.Contains(registration.Implementation)) registration.Implementation = null;
                if (registration.RegisteredIn != null && !ids.Contains(registration.RegisteredIn)) registration.RegisteredIn = null;
                registration.Location = registration.Location == null ? null : Relative(registration.Location, root);
            }

            var dependencies = di.Dependencies.Count;
            di.Dependencies = di.Dependencies.Where(d => ids.Contains(d.Consumer) && (d.External || ids.Contains(d.Service))).ToList();
            Count(registrations - di.Registrations.Count + dependencies - di.Dependencies.Count, "DI entries named unknown nodes");
            if (di.Registrations.Count == 0 && di.Dependencies.Count == 0) graph.Analysis.Di = null;
        }

        Count(foreign, $"nodes had ids outside '{plugin.IdPrefix}'");
        Count(duplicates, "duplicate node ids");
        Count(levels, "unknown levels");
        Count(locations, "locations outside the root");
        Count(parents, "parents that do not exist");
        Count(cycles, "parent cycles");
        Count(danglingEdges, "edges to nodes that do not exist");
        if (problems.Count > 0) graph.Analysis.Warnings.Add($"{plugin.Name}: dropped or fixed {string.Join(", ", problems)}.");

        graph.Nodes = nodes;
        graph.Edges = edges;
        if (string.IsNullOrEmpty(graph.Source.Root)) graph.Source.Root = root;
        return graph;
    }

    /// <summary>A location relative to the root with forward slashes, or null when it is outside.</summary>
    private static SourceLocation? Relative(SourceLocation location, string root)
    {
        if (location.Line < 1) return null;
        var file = location.File.Replace('\\', '/');
        if (Path.IsPathRooted(file))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (Path.IsPathRooted(relative)) return null;
            file = relative;
        }

        if (file.Length == 0 || file == ".." || file.StartsWith("../", StringComparison.Ordinal) || file.Contains("/../", StringComparison.Ordinal)) return null;
        location.File = file;
        if (location.EndLine < location.Line) location.EndLine = location.Line;
        return location;
    }
}
