using System.Text;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>The Mermaid diagrams of samples/Shop against Golden/shop.mermaid.md (regenerate with CODEMAP_UPDATE_GOLDEN=1).</summary>
public class MermaidTests
{
    [Fact]
    public void Shop_diagrams_match_the_golden_file()
    {
        var graph = CodeMapAnalyzer.Analyze(Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln"), LanguageRegistry.BuiltIn, new AnalyzerOptions { Git = false });
        var index = new GraphIndex(graph);
        var cycle = graph.Analysis.Cycles.First(c => c.Level == NodeLevels.Namespace);
        var sections = new (string Title, string Mermaid)[]
        {
            ("Projects", MermaidExporter.Dependencies(index, NodeLevels.Project)),
            ("Around PlaceOrderHandler", MermaidExporter.Dependencies(index, NodeLevels.Type, new[] { "T:Shop.Application.Orders.PlaceOrderHandler" }, maxNodes: 8)),
            ("Layers of namespaces", MermaidExporter.Layers(index)),
            ("A namespace cycle", MermaidExporter.Cycle(index, cycle.Nodes, cycle.Level)),
            ("Class PlaceOrderHandler", MermaidExporter.Class(index, "T:Shop.Application.Orders.PlaceOrderHandler")),
            ("DI", MermaidExporter.Di(index)),
        };

        var sb = new StringBuilder("# Mermaid diagrams of samples/Shop\n");
        foreach (var (title, mermaid) in sections) sb.Append($"\n## {title}\n\n```mermaid\n{mermaid}```\n");
        var actual = sb.ToString();
        var golden = Path.Combine(GoldenTests.RepoRoot(), "tests", "CodeMap.Tests", "Golden", "shop.mermaid.md");
        if (Environment.GetEnvironmentVariable("CODEMAP_UPDATE_GOLDEN") == "1") File.WriteAllText(golden, actual);
        Assert.Equal(File.ReadAllText(golden).ReplaceLineEndings("\n"), actual);
        Assert.Contains("more not shown", sections[1].Mermaid);
    }
}
