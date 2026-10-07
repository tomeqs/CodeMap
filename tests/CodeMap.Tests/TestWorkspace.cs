using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>Creates a throw-away folder with projects / sources and analyzes it.</summary>
internal sealed class TestWorkspace : IDisposable
{
    public TestWorkspace()
    {
        Root = Path.Combine(Path.GetTempPath(), "codemap-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
    }

    public string Root { get; }

    public TestWorkspace File(string relativePath, string content)
    {
        var path = Path.Combine(Root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        System.IO.File.WriteAllText(path, content);
        return this;
    }

    public TestWorkspace Project(string name, string? references = null, string sdk = "Microsoft.NET.Sdk", string extra = "")
    {
        var refs = references == null
            ? ""
            : "<ItemGroup>" + string.Concat(references.Split(',').Select(r => $"<ProjectReference Include=\"../{r}/{r}.csproj\" />")) + "</ItemGroup>";
        return File($"{name}/{name}.csproj", $"""
            <Project Sdk="{sdk}">
              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
                <ImplicitUsings>enable</ImplicitUsings>
                <Nullable>enable</Nullable>
                {extra}
              </PropertyGroup>
              {refs}
            </Project>
            """);
    }

    public CodeGraph Analyze(string? path = null, AnalyzerOptions? options = null) =>
        CodeMapAnalyzer.Analyze(path ?? Root, options ?? new AnalyzerOptions { Git = false });

    public void Dispose()
    {
        try { Directory.Delete(Root, recursive: true); }
        catch { /* best effort */ }
    }
}

internal static class GraphAssertions
{
    public static GraphNode Node(this CodeGraph graph, string id) =>
        graph.Nodes.SingleOrDefault(n => n.Id == id) ?? throw new Xunit.Sdk.XunitException($"Node {id} not found. Nodes: {string.Join(", ", graph.Nodes.Select(n => n.Id))}");

    public static bool HasEdge(this CodeGraph graph, string source, string kind, string target) =>
        graph.Edges.Any(e => e.Source == source && e.Kind == kind && e.Target == target);

    public static void AssertEdge(this CodeGraph graph, string source, string kind, string target)
    {
        if (!graph.HasEdge(source, kind, target))
        {
            var outgoing = graph.Edges.Where(e => e.Source == source).Select(e => $"  -{e.Kind}-> {e.Target}");
            throw new Xunit.Sdk.XunitException($"Missing edge {source} -{kind}-> {target}. Outgoing:\n{string.Join("\n", outgoing)}");
        }
    }

    public static void AssertNoEdge(this CodeGraph graph, string source, string kind, string target) =>
        Assert.False(graph.HasEdge(source, kind, target), $"Unexpected edge {source} -{kind}-> {target}");
}
