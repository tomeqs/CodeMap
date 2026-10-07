using System.Diagnostics;
using CodeMap.Analysis;
using CodeMap.Loading;
using CodeMap.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeMap;

/// <summary>Entry point of the library: turns a C# solution / project / folder into a <see cref="CodeGraph"/>.</summary>
public static class CodeMapAnalyzer
{
    public static CodeGraph Analyze(string path, AnalyzerOptions? options = null, CancellationToken ct = default)
    {
        options ??= new AnalyzerOptions();
        var log = options.Log ?? (_ => { });
        var stopwatch = Stopwatch.StartNew();

        var load = ProjectLoader.Load(path);
        var warnings = new List<string>(load.Warnings);
        var projects = load.Projects.Where(p => options.IncludeTests || !p.IsTestProject).ToList();
        log($"Found {projects.Count} project(s) in {load.SourcePath}");

        var ordered = TopologicalOrder(projects);
        var assemblyToProject = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var project in ordered)
        {
            if (!assemblyToProject.TryAdd(project.AssemblyName, project.Name))
            {
                warnings.Add($"Assembly name '{project.AssemblyName}' is used by more than one project; '{project.Name}' is merged into '{assemblyToProject[project.AssemblyName]}'.");
            }
        }

        var builder = new GraphBuilder(options, load.Root, assemblyToProject);
        var byPath = ordered.ToDictionary(p => p.FilePath, StringComparer.OrdinalIgnoreCase);
        foreach (var project in ordered) DeclareProject(builder, project, byPath, load.Root);

        var factory = new CompilationFactory(warnings);
        var compilations = new Dictionary<string, CSharpCompilation>(StringComparer.OrdinalIgnoreCase);
        var projectLines = new Dictionary<string, (int Files, int Lines)>();

        foreach (var project in ordered)
        {
            ct.ThrowIfCancellationRequested();
            var references = TransitiveReferences(project, byPath)
                .Where(compilations.ContainsKey)
                .Select(p => (MetadataReference)compilations[p].ToMetadataReference())
                .ToList();

            var compilation = factory.Create(project, references, ct);
            compilations[project.FilePath] = compilation;

            var trees = compilation.SyntaxTrees
                .Where(t => !CompilationFactory.IsSyntheticTree(t))
                .Where(t => options.IncludeGenerated || !IsGenerated(t, ct))
                .ToList();

            Parallel.ForEach(trees, new ParallelOptions { CancellationToken = ct }, tree =>
            {
                var model = compilation.GetSemanticModel(tree, ignoreAccessibility: true);
                new TypeAnalyzer(builder, model, project.Name, project.IsTestProject).Run(ct);
            });

            projectLines[project.Name] = (trees.Count, trees.Sum(t => t.GetText(ct).Lines.Count));
            log($"  {project.Name}: {trees.Count} file(s)");
        }

        var graph = builder.Build(ordered.Select(p => p.Name).ToList());

        foreach (var node in graph.Nodes.Where(n => n.Kind == NodeKinds.Project))
        {
            if (projectLines.TryGetValue(node.Name, out var lines))
            {
                node.SetMetric("files", lines.Files);
                node.SetMetric("lines", lines.Lines);
            }
        }

        GraphMetrics.Compute(graph);

        if (options.Git)
        {
            var history = GitHistory.Read(load.Root, options.GitSince, options.GitMaxCommits, log);
            if (history is { CommitCount: > 0 })
            {
                ApplyGit(graph, history, load.Root);
                GraphMetrics.ComputeHotspots(graph);
                graph.Source.Git = new GitInfo { Branch = history.Branch, Commit = history.Head, CommitsAnalyzed = history.CommitCount, Since = options.GitSince };
            }
        }

        graph.Source.Path = load.SourcePath;
        graph.Source.Root = load.Root;
        graph.Source.Kind = load.Kind;
        graph.Source.Name = load.Name;
        graph.Analysis.Warnings = warnings;
        graph.Stats = ComputeStats(graph);

        log($"Analysis finished in {stopwatch.Elapsed.TotalSeconds:0.0}s: {graph.Nodes.Count} nodes, {graph.Edges.Count} edges");
        return graph;
    }

    private static void DeclareProject(GraphBuilder builder, ProjectInfo project, Dictionary<string, ProjectInfo> byPath, string root)
    {
        var key = builder.ProjectKey(project.Name);
        var draft = builder.GetOrAddNode(key, () => new GraphNode
        {
            Kind = NodeKinds.Project,
            Name = project.Name,
            FullName = project.IsVirtual ? project.Name : Path.GetRelativePath(root, project.FilePath).Replace('\\', '/'),
            Project = key,
            Signature = string.Join(" · ", new[] { project.Sdk, project.TargetFramework, project.OutputType }.Where(s => !string.IsNullOrEmpty(s))),
            Location = project.IsVirtual ? null : new SourceLocation { File = Path.GetRelativePath(root, project.FilePath).Replace('\\', '/'), Line = 1, EndLine = 1 },
        });

        if (project.IsTestProject) draft.Node.AddTag(Tags.TestProject);
        if (project.OutputType.Contains("exe", StringComparison.OrdinalIgnoreCase)) draft.Node.AddTag(Tags.EntryPoint);

        foreach (var reference in project.ProjectReferences)
        {
            if (byPath.TryGetValue(reference, out var target)) builder.AddEdge(key, builder.ProjectKey(target.Name), EdgeKinds.ProjectReference);
        }

        foreach (var package in project.PackageReferences)
        {
            var packageKey = "package:" + package.Name;
            builder.GetOrAddNode(packageKey, () => new GraphNode
            {
                Kind = NodeKinds.Package,
                Name = package.Name,
                FullName = package.Name,
                Signature = package.Version,
                External = true,
            });
            builder.AddEdge(key, packageKey, EdgeKinds.PackageReference);
        }
    }

    private static void ApplyGit(CodeGraph graph, GitHistory history, string root)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        foreach (var node in graph.Nodes.Where(n => NodeKinds.IsType(n.Kind) && !n.External && n.Location != null))
        {
            var files = new[] { node.Location! }.Concat(node.ExtraLocations ?? new List<SourceLocation>())
                .Select(l => Path.GetFullPath(Path.Combine(root, l.File)))
                .Distinct(StringComparer.Ordinal);

            var commits = 0;
            var churn = 0;
            long last = 0;
            var authors = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in files)
            {
                if (!history.Files.TryGetValue(file, out var stats)) continue;
                commits += stats.Commits;
                churn += stats.Churn;
                last = Math.Max(last, stats.LastCommitUnix);
                authors.UnionWith(stats.Authors);
            }

            if (commits == 0) continue;
            node.SetMetric("commits", commits);
            node.SetMetric("churn", churn);
            node.SetMetric("authors", authors.Count);
            node.SetMetric("ageDays", Math.Max(0, (now - last) / 86400));
        }
    }

    private static Dictionary<string, int> ComputeStats(CodeGraph graph)
    {
        var internalNodes = graph.Nodes.Where(n => !n.External).ToList();
        var stats = new Dictionary<string, int>
        {
            ["projects"] = internalNodes.Count(n => n.Kind == NodeKinds.Project),
            ["namespaces"] = internalNodes.Count(n => n.Kind == NodeKinds.Namespace),
            ["types"] = internalNodes.Count(n => NodeKinds.IsType(n.Kind)),
            ["members"] = internalNodes.Count(n => NodeKinds.IsMember(n.Kind)),
            ["packages"] = graph.Nodes.Count(n => n.Kind == NodeKinds.Package),
            ["externalTypes"] = graph.Nodes.Count(n => n.External && NodeKinds.IsType(n.Kind)),
            ["edges"] = graph.Edges.Count,
            ["files"] = (int)internalNodes.Where(n => n.Kind == NodeKinds.Project).Sum(n => n.Metric("files")),
            ["lines"] = (int)internalNodes.Where(n => n.Kind == NodeKinds.Project).Sum(n => n.Metric("lines")),
            ["cycles"] = graph.Analysis.Cycles.Count,
        };
        foreach (var group in graph.Edges.GroupBy(e => e.Kind)) stats["edges." + group.Key] = group.Count();
        return stats;
    }

    private static IEnumerable<string> TransitiveReferences(ProjectInfo project, Dictionary<string, ProjectInfo> byPath)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<string>(project.ProjectReferences);
        while (queue.Count > 0)
        {
            var path = queue.Dequeue();
            if (!seen.Add(path)) continue;
            yield return path;
            if (byPath.TryGetValue(path, out var p)) foreach (var r in p.ProjectReferences) queue.Enqueue(r);
        }
    }

    private static List<ProjectInfo> TopologicalOrder(List<ProjectInfo> projects)
    {
        var byPath = projects.ToDictionary(p => p.FilePath, StringComparer.OrdinalIgnoreCase);
        var result = new List<ProjectInfo>();
        var state = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase); // 1 = visiting, 2 = done

        void Visit(ProjectInfo project)
        {
            if (state.TryGetValue(project.FilePath, out var s) && s > 0) return; // done, or a cycle we simply cut
            state[project.FilePath] = 1;
            foreach (var reference in project.ProjectReferences)
            {
                if (byPath.TryGetValue(reference, out var dependency)) Visit(dependency);
            }

            state[project.FilePath] = 2;
            result.Add(project);
        }

        foreach (var project in projects.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)) Visit(project);
        return result;
    }

    private static readonly string[] GeneratedSuffixes = { ".g.cs", ".g.i.cs", ".generated.cs", ".designer.cs", "AssemblyInfo.cs", "AssemblyAttributes.cs" };

    internal static bool IsGenerated(SyntaxTree tree, CancellationToken ct)
    {
        var path = tree.FilePath;
        if (GeneratedSuffixes.Any(s => path.EndsWith(s, StringComparison.OrdinalIgnoreCase))) return true;
        var text = tree.GetText(ct);
        var head = text.ToString(new Microsoft.CodeAnalysis.Text.TextSpan(0, Math.Min(text.Length, 2048)));
        return head.Contains("<auto-generated", StringComparison.OrdinalIgnoreCase) || head.Contains("<autogenerated", StringComparison.OrdinalIgnoreCase);
    }
}
