using System.Text.RegularExpressions;
using CodeMap.Analysis;
using CodeMap.Loading;
using CodeMap.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeMap.Languages.CSharp;

/// <summary>C# with Roslyn: solutions, projects, folders and single files, read without a build or restore.</summary>
public sealed class CSharpAnalyzer : ILanguageAnalyzer
{
    private static readonly HashSet<string> NonPublic = new() { "private", "internal", "private protected" };
    private static readonly string[] FileInputs = { ".sln", ".slnx", ".slnf", ".csproj", ".cs" };

    public LanguageInfo Info { get; } = new()
    {
        Id = "csharp",
        Name = "C#",
        Inputs = "a .sln, .slnx, .slnf, .csproj, .cs file",
        Markers = ".csproj or .cs files",
        External = "BCL / NuGet",
        Unused = new UnusedPolicy
        {
            MemberAccessibility = NonPublic,
            TypeAccessibility = NonPublic,
            SkipTags = new HashSet<string> { Tags.EntryPoint, Tags.Test },
            SkipMemberKinds = new HashSet<string> { NodeKinds.Constructor },
            SkipModifiers = new HashSet<string> { "override" },
            SkipNames = new HashSet<string> { "Dispose", "DisposeAsync", "ToString", "Equals", "GetHashCode", "Main" },
            SkipNamePattern = new Regex("^operator| operator ", RegexOptions.CultureInvariant),
            SkipParentKinds = new HashSet<string> { NodeKinds.Interface },
            SkipParentTags = new HashSet<string> { Tags.Test },
            SkipTypeTags = new HashSet<string> { Tags.Controller, Tags.HostedService, Tags.Middleware, Tags.Generated },
        },
    };

    public bool CanAnalyzeFile(string path) => FileInputs.Contains(Path.GetExtension(path).ToLowerInvariant());

    public bool Detect(string directory, CancellationToken ct) =>
        ProjectLoader.EnumerateFiles(directory, "*.csproj").Any() || ProjectLoader.EnumerateFiles(directory, "*.cs").Any();

    public CodeGraph Analyze(string path, AnalyzerOptions options, CancellationToken ct)
    {
        var log = options.Log ?? (_ => { });
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

        graph.Analysis.Di = ContainerSetup(builder);
        graph.Analysis.Warnings = warnings;
        graph.Source.Path = load.SourcePath;
        graph.Source.Root = load.Root;
        graph.Source.Kind = load.Kind;
        graph.Source.Name = load.Name;
        return graph;
    }

    /// <summary>The registrations and constructor dependencies the analysis found, with public ids.</summary>
    private static DiAnalysis? ContainerSetup(GraphBuilder builder)
    {
        string? Resolve(string ident) => ident.StartsWith("ext:", StringComparison.Ordinal) ? ident : builder.IdOf(ident);

        var di = new DiAnalysis();
        foreach (var draft in builder.Registrations
                     .OrderBy(r => r.Location.File, StringComparer.Ordinal)
                     .ThenBy(r => r.Location.Line)
                     .ThenBy(r => r.ServiceIdent, StringComparer.Ordinal))
        {
            var service = Resolve(draft.ServiceIdent);
            if (service == null) continue;
            var external = service.StartsWith("ext:", StringComparison.Ordinal);
            di.Registrations.Add(new ServiceRegistration
            {
                Service = external ? service[4..] : service,
                External = external,
                Implementation = builder.IdOf(draft.ImplementationKey),
                Lifetime = draft.Lifetime,
                Kind = draft.Kind,
                Key = draft.Key,
                RegisteredIn = builder.IdOf(draft.SourceKey),
                Location = draft.Location,
            });
        }

        foreach (var (key, dependencies) in builder.ConstructorDependencies.OrderBy(d => d.Key, StringComparer.Ordinal))
        {
            if (builder.IdOf(key) is not { } consumer) continue;
            foreach (var dependency in dependencies)
            {
                var service = Resolve(dependency.ServiceIdent);
                if (service == null) continue;
                di.Dependencies.Add(new DiDependency
                {
                    Consumer = consumer,
                    Service = dependency.External ? service[4..] : service,
                    External = dependency.External,
                    Many = dependency.Many,
                    Optional = dependency.Optional,
                });
            }
        }

        return di.Registrations.Count == 0 && di.Dependencies.Count == 0 ? null : di;
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
