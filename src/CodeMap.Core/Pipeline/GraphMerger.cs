using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>Puts the graphs of several languages found in one folder side by side in one map.</summary>
internal static class GraphMerger
{
    public static CodeGraph Merge(string directory, IReadOnlyList<CodeGraph> fragments)
    {
        var graph = new CodeGraph();
        graph.Source.Path = directory;
        graph.Source.Root = directory;
        graph.Source.Kind = "directory";
        graph.Source.Name = new DirectoryInfo(directory).Name;

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var duplicates = new List<string>();
        var di = new DiAnalysis();
        foreach (var fragment in fragments)
        {
            graph.Analysis.Warnings.AddRange(fragment.Analysis.Warnings);
            var rebase = RebaseFrom(fragment.Source.Root, directory);
            foreach (var node in fragment.Nodes)
            {
                if (!ids.Add(node.Id))
                {
                    duplicates.Add(node.Id);
                    continue;
                }

                node.Location = rebase(node.Location);
                node.ExtraLocations = node.ExtraLocations?.Select(l => rebase(l)!).ToList();
                graph.Nodes.Add(node);
            }

            graph.Edges.AddRange(fragment.Edges);
            if (fragment.Analysis.Diagnostics is { } diagnostics)
            {
                foreach (var diagnostic in diagnostics) diagnostic.Location = rebase(diagnostic.Location)!;
                (graph.Analysis.Diagnostics ??= new List<CodeDiagnostic>()).AddRange(diagnostics);
            }

            if (fragment.Analysis.Di is { } setup)
            {
                foreach (var registration in setup.Registrations) registration.Location = rebase(registration.Location);
                di.Registrations.AddRange(setup.Registrations);
                di.Dependencies.AddRange(setup.Dependencies);
            }
        }

        if (duplicates.Count > 0)
        {
            graph.Analysis.Warnings.Add($"{duplicates.Count} node id(s) came from more than one language; the first was kept (e.g. {duplicates[0]}).");
        }

        graph.Analysis.Di = di.Registrations.Count == 0 && di.Dependencies.Count == 0 ? null : di;
        graph.Nodes.Sort((a, b) =>
        {
            var c = Rank(a).CompareTo(Rank(b));
            return c != 0 ? c : string.CompareOrdinal(a.Id, b.Id);
        });
        graph.Edges.Sort((a, b) =>
        {
            var c = string.CompareOrdinal(a.Source, b.Source);
            if (c == 0) c = string.CompareOrdinal(a.Kind, b.Kind);
            return c != 0 ? c : string.CompareOrdinal(a.Target, b.Target);
        });
        return graph;
    }

    /// <summary>Locations relative to a language's own root, made relative to the merged root.</summary>
    private static Func<SourceLocation?, SourceLocation?> RebaseFrom(string root, string directory)
    {
        if (string.IsNullOrEmpty(root) || Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) == directory.TrimEnd(Path.DirectorySeparatorChar))
        {
            return location => location;
        }

        return location => location == null
            ? null
            : new SourceLocation
            {
                File = Path.GetRelativePath(directory, Path.Combine(root, location.File)).Replace('\\', '/'),
                Line = location.Line,
                EndLine = location.EndLine,
            };
    }

    /// <summary>Same order as a single language's graph: containers, then types and members, then what is external.</summary>
    private static int Rank(GraphNode node) => node.Kind switch
    {
        NodeKinds.Package => 4,
        NodeKinds.Assembly => 5,
        _ => NodeLevels.Of(node) switch
        {
            NodeLevels.Project => 0,
            NodeLevels.Namespace => 1,
            NodeLevels.Type => node.External ? 6 : 2,
            _ => 3,
        },
    };
}
