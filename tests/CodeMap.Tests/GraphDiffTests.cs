using CodeMap.Analysis;
using CodeMap.Insights;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>GraphDiff: two maps of the same code before and after a change.</summary>
public class GraphDiffTests
{
    private static GraphDiffReport Diff(CodeGraph before, CodeGraph after, string level = NodeLevels.Namespace)
    {
        var (b, a) = (new GraphIndex(before), new GraphIndex(after));
        return GraphDiff.Compare(b, FindingsAnalysis.Compute(before, null, b), a, FindingsAnalysis.Compute(after, null, a), level);
    }

    private const string Cycle = """
        namespace App.Orders { public class Order { public App.Customers.Customer? Owner; public void Notify() => Owner!.Tell(); } }
        namespace App.Customers { public class Customer { public void Tell() { } public App.Orders.Order? Last; } }
        """;

    [Fact]
    public void The_same_code_twice_has_no_differences()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", Cycle);
        var diff = Diff(ws.Analyze(), ws.Analyze());

        Assert.Equal(0, diff.Score.Delta);
        Assert.Empty(diff.Nodes.Added);
        Assert.Empty(diff.Nodes.Removed);
        Assert.Empty(diff.Nodes.Moved);
        Assert.Empty(diff.Findings.Resolved);
        Assert.Empty(diff.Findings.Added);
        Assert.Empty(diff.Dependencies.Added);
        Assert.Empty(diff.Dependencies.Removed);
        Assert.All(diff.Cycles, c => Assert.Equal(c.Before, c.After));
    }

    [Fact]
    public void Breaking_a_cycle_resolves_the_cycle_its_finding_and_the_upward_dependency()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", Cycle);
        var before = ws.Analyze();
        ws.File("App/A.cs", Cycle.Replace(" public App.Orders.Order? Last;", ""));
        var after = ws.Analyze();

        var diff = Diff(before, after);
        var namespaces = diff.Cycles.Single(c => c.Level == NodeLevels.Namespace);
        Assert.Equal((1, 0), (namespaces.Before, namespaces.After));
        Assert.Equal(new[] { "namespace:App/App.Customers", "namespace:App/App.Orders" }, Assert.Single(namespaces.Resolved).Nodes);
        Assert.Contains(diff.Findings.Resolved, f => f.Rule == "cycle.namespace");
        Assert.Empty(diff.Findings.Added);
        Assert.Single(diff.Upward.Resolved);
        Assert.Contains(diff.Dependencies.Removed, d => d.Source == "namespace:App/App.Customers" && d.Target == "namespace:App/App.Orders");
        Assert.True(diff.Score.Delta >= 0);
        Assert.Contains(diff.Summary, l => l.StartsWith("namespace cycles: 1 → 0", StringComparison.Ordinal));
    }

    [Fact]
    public void A_type_moved_to_another_namespace_is_matched_and_reported_as_moved()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/Orders.cs", "namespace App.Orders { public class Order { public App.Billing.Invoice? Invoice; } public class Line { } }");
        ws.File("App/Billing.cs", "namespace App.Billing { public class Invoice { public decimal Total; } public class Tax { } }");
        var before = ws.Analyze();
        ws.File("App/Orders.cs", "namespace App.Orders { public class Order { public Invoice? Invoice; } public class Line { } public class Invoice { public decimal Total; } }");
        ws.File("App/Billing.cs", "namespace App.Billing { public class Tax { } }");
        var after = ws.Analyze();

        var diff = Diff(before, after);
        var moved = Assert.Single(diff.Nodes.Moved);
        Assert.Equal(("T:App.Billing.Invoice", "T:App.Orders.Invoice"), (moved.Before, moved.After));
        Assert.Equal(("namespace:App/App.Billing", "namespace:App/App.Orders"), (moved.FromContainer, moved.ToContainer));
        Assert.DoesNotContain("T:App.Orders.Invoice", diff.Nodes.Added);
        Assert.DoesNotContain("T:App.Billing.Invoice", diff.Nodes.Removed);
        Assert.Contains(diff.Dependencies.Removed, d => d.Source == "namespace:App/App.Orders" && d.Target == "namespace:App/App.Billing");
    }

    [Fact]
    public void A_renamed_namespace_is_matched_by_the_types_that_moved_with_it()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App.Old { public class A { public B? B; } public class B { public C? C; } public class C { } }\nnamespace App.Use { public class User { public App.Old.A? A; } }");
        var before = ws.Analyze();
        ws.File("App/A.cs", "namespace App.Core { public class A { public B? B; } public class B { public C? C; } public class C { } }\nnamespace App.Use { public class User { public App.Core.A? A; } }");
        var after = ws.Analyze();

        var diff = Diff(before, after);
        Assert.Contains(diff.Nodes.Renamed, r => r.Before == "namespace:App/App.Old" && r.After == "namespace:App/App.Core");
        Assert.Equal(3, diff.Nodes.Moved.Count(m => m.Before.StartsWith("T:App.Old.", StringComparison.Ordinal)));
        Assert.Empty(diff.Dependencies.Added); // App.Use → App.Core is App.Use → App.Old under its new name
        Assert.Empty(diff.Dependencies.Removed);
    }

    [Fact]
    public void A_renamed_type_is_matched_by_its_members()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App; public class PriceRules { public int Base() => 1; public int Discount() => 2; public int Total() => 3; }");
        var before = ws.Analyze();
        ws.File("App/A.cs", "namespace App; public class Pricing { public int Base() => 1; public int Discount() => 2; public int Total() => 3; }");
        var after = ws.Analyze();

        var diff = Diff(before, after);
        Assert.Contains(diff.Nodes.Renamed, r => (r.Before, r.After) == ("T:App.PriceRules", "T:App.Pricing"));
        Assert.Empty(diff.Nodes.Added);
        Assert.Empty(diff.Nodes.Removed);
    }
}
