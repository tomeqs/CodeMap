using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Tests;

public class ChangeCouplingTests
{
    [Fact]
    public void Finds_types_that_change_together_and_flags_hidden_coupling()
    {
        using var ws = new TestWorkspace().Project("App").Git("init", "-q");
        string Version(string type, int v, string body = "") => $"namespace App; public class {type} {{ public int V{v} => {v}; {body} }}";

        // PriceRules and InvoiceFormatter never reference each other but always change together.
        ws.Commit("one", ("App/PriceRules.cs", Version("PriceRules", 1)), ("App/InvoiceFormatter.cs", Version("InvoiceFormatter", 1)), ("App/Order.cs", Version("Order", 1)));
        ws.Commit("two", ("App/PriceRules.cs", Version("PriceRules", 2)), ("App/InvoiceFormatter.cs", Version("InvoiceFormatter", 2)));
        ws.Commit("three", ("App/PriceRules.cs", Version("PriceRules", 3)), ("App/InvoiceFormatter.cs", Version("InvoiceFormatter", 3)));
        // Order uses PriceRules and changes with it twice: coupled, but not hidden.
        ws.Commit("four", ("App/Order.cs", Version("Order", 4, "public PriceRules Rules { get; } = new();")), ("App/PriceRules.cs", Version("PriceRules", 4)));
        ws.Commit("five", ("App/Order.cs", Version("Order", 5, "public PriceRules Rules { get; } = new();")), ("App/PriceRules.cs", Version("PriceRules", 5)));
        ws.Commit("six", ("App/Order.cs", Version("Order", 6, "public PriceRules Rules { get; } = new();")));

        var graph = ws.Analyze(options: new AnalyzerOptions());

        var hidden = Assert.Single(graph.Analysis.ChangeCoupling, c => c.Hidden);
        Assert.Equal(("T:App.InvoiceFormatter", "T:App.PriceRules"), (hidden.Source, hidden.Target));
        Assert.Equal(3, hidden.SharedCommits);
        Assert.Equal(Math.Round(2.0 * 3 / (3 + 5), 3), hidden.Strength); // InvoiceFormatter: 3 commits, PriceRules: 5

        var visible = Assert.Single(graph.Analysis.ChangeCoupling, c => !c.Hidden);
        Assert.Equal(("T:App.Order", "T:App.PriceRules"), (visible.Source, visible.Target));

        graph.AssertEdge("T:App.InvoiceFormatter", EdgeKinds.ChangesWith, "T:App.PriceRules");
        // Change coupling is not a dependency: it must not influence coupling metrics.
        Assert.Equal(0, graph.Node("T:App.InvoiceFormatter").Metric("ce"));
    }

    [Fact]
    public void Ignores_huge_commits()
    {
        using var ws = new TestWorkspace().Project("App").Git("init", "-q");
        for (var round = 0; round < 3; round++)
        {
            var files = Enumerable.Range(0, ChangeCouplingAnalysis.MaxFilesPerCommit + 1)
                .Select(i => ($"App/T{i}.cs", $"namespace App; public class T{i} {{ int R{round}; }}"))
                .ToArray();
            ws.Commit("bulk " + round, files);
        }

        var graph = ws.Analyze(options: new AnalyzerOptions());

        Assert.Empty(graph.Analysis.ChangeCoupling);
    }
}
