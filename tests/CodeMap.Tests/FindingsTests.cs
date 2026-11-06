using System.Text;
using System.Text.Json;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// FindingsAnalysis: each rule on a small workspace that has the problem and one that is a near miss, the stable ids
/// and the health score, and the whole report of samples/Shop as a golden file (Golden/shop.findings.json).
/// </summary>
public class FindingsTests
{
    private static readonly AnalyzerOptions NoGit = new() { Git = false };

    private static FindingsReport Findings(TestWorkspace ws, AnalyzerOptions? options = null, FindingOptions? findings = null) =>
        FindingsAnalysis.Compute(ws.Analyze(options: options ?? NoGit), findings);

    private static Finding Single(FindingsReport report, string rule, string? node = null)
    {
        var matches = report.Findings.Where(f => f.Rule == rule && (node == null || f.Nodes.Contains(node))).ToList();
        if (matches.Count == 1) return matches[0];
        throw new Xunit.Sdk.XunitException($"Expected one {rule}{(node != null ? " for " + node : "")}, found {matches.Count}. All: {string.Join(", ", report.Findings.Select(f => f.Id))}");
    }

    private static void None(FindingsReport report, string rule, string? node = null) =>
        Assert.DoesNotContain(report.Findings, f => f.Rule == rule && (node == null || f.Nodes.Contains(node)));

    // ------------------------------------------------------------------ the smells of one class

    private static readonly Lazy<FindingsReport> Smells = new(() =>
    {
        using var ws = new TestWorkspace().Project("App");
        var godMethods = string.Concat(Enumerable.Range(0, 10).Select(i =>
            $"public int M{i}(int x) {{ {(i < 6 ? $"var v = _h{i}.P{i};" : $"var v = _f{i};")} if (x > 1) v++; if (x > 2) v++; if (x > 3) v++; if (x > 4) v++; return v; }}\n"));
        var godFields = string.Concat(Enumerable.Range(0, 10).Select(i => i < 6 ? $"private Data _h{i} = new();\n" : $"private int _f{i};\n"));
        var longBody = string.Concat(Enumerable.Range(0, 64).Select(i => $"        total += {i};\n"));
        var complexBody = string.Concat(Enumerable.Range(0, 15).Select(i => $"        if (x == {i}) return {i};\n"));
        var manyMembers = string.Concat(Enumerable.Range(0, 41).Select(i => $"    public int M{i}() => {i};\n"));
        ws.File("App/Smells.cs", $$"""
            namespace App;

            public class Data { public int P0 { get; set; } public int P1 { get; set; } public int P2 { get; set; } public int P3 { get; set; } public int P4 { get; set; } public int P5 { get; set; } }
            public class Godly
            {
            {{godFields}}
            {{godMethods}}
            }

            public class Order { public decimal Price { get; set; } public int Quantity { get; set; } public decimal Discount { get; set; } }
            public class Envious
            {
                private int _calls;
                public decimal Total(Order order) => order.Price * order.Quantity - order.Discount;
                public static decimal Static(Order order) => order.Price * order.Quantity - order.Discount;
                public int Calls() => _calls;
            }

            public class Sizes
            {
                public int Long()
                {
                    var total = 0;
            {{longBody}}
                    return total;
                }

                public int Complex(int x)
                {
            {{complexBody}}
                    return -1;
                }

                public int Many(int a, int b, int c, int d, int e, int f, int g) => a + b + c + d + e + f + g;
                public int Few(int a, int b, int c, int d, int e, int f) => a + b + c + d + e + f;
            }

            public class Wide
            {
            {{manyMembers}}
            }

            public class Base0 { } public class Base1 : Base0 { } public class Base2 : Base1 { } public class Base3 : Base2 { } public class Base4 : Base3 { }
            public class Shallow0 { } public class Shallow1 : Shallow0 { } public class Shallow2 : Shallow1 { } public class Shallow3 : Shallow2 { }

            public interface IWorker { int A(); int B(); int C(); int D(); }
            public class Worker : IWorker { public int A() => 1; public int B() => 2; public int C() => 3; public int D() => 4; }
            public class Relay
            {
                private readonly Worker _worker = new();
                public int A() => _worker.A();
                public int B() => _worker.B();
                public int C() => _worker.C();
                public int D() => _worker.D();
            }
            public class LoggingWorker(IWorker inner) : IWorker
            {
                public int A() => inner.A();
                public int B() => inner.B();
                public int C() => inner.C();
                public int D() => inner.D();
            }

            public interface IPlugin { void Run(); }
            public class Host { public void Use(IPlugin plugin) => plugin.Run(); public void Use(IWorker worker) => worker.A(); }

            public class Hidden
            {
                private void Unused() { }
                private int _unusedField;
                public void Used() { }
            }
            """);
        return Findings(ws);
    });

    [Fact]
    public void A_complex_class_working_on_other_classes_data_with_little_cohesion_is_a_god_class()
    {
        var god = Single(Smells.Value, "god-class", "T:App.Godly");
        Assert.Equal(FindingSeverity.Warning, god.Severity);
        Assert.Equal(50, god.Evidence["wmc"]);
        Assert.Equal(6, god.Evidence["atfd"]);
        Assert.Equal(0, god.Evidence["tcc"]);
        Assert.Contains("split-type", god.ProposalKinds);
        Assert.Equal("App/Smells.cs", god.Locations.Single().File);
        None(Smells.Value, "large-type", "T:App.Godly");
    }

    [Fact]
    public void A_method_using_another_classes_data_more_than_its_own_envies_it()
    {
        var envy = Single(Smells.Value, "feature-envy");
        Assert.Equal(new[] { "M:App.Envious.Total(App.Order)", "T:App.Order" }, envy.Nodes);
        Assert.Equal(3, envy.Evidence["atfd"]);
        Assert.Equal(0, envy.Evidence["laa"]);
        Assert.Contains("Move Total", envy.Suggestion);
    }

    [Fact]
    public void Long_complex_and_wide_methods_and_large_types_are_reported_with_their_numbers()
    {
        Assert.True(Single(Smells.Value, "long-method").Evidence["loc"] >= 60);
        Assert.Equal(16, Single(Smells.Value, "complex-method").Evidence["complexity"]);
        Assert.Equal("M:App.Sizes.Many(System.Int32,System.Int32,System.Int32,System.Int32,System.Int32,System.Int32,System.Int32)", Single(Smells.Value, "many-parameters").Nodes[0]);
        Assert.Equal(41, Single(Smells.Value, "large-type", "T:App.Wide").Evidence["members"]);
    }

    [Fact]
    public void Four_levels_of_internal_base_classes_are_deep_inheritance_three_are_not()
    {
        var deep = Single(Smells.Value, "deep-inheritance");
        Assert.Equal(new[] { "T:App.Base4", "T:App.Base3", "T:App.Base2", "T:App.Base1", "T:App.Base0" }, deep.Nodes);
        None(Smells.Value, "deep-inheritance", "T:App.Shallow3");
    }

    [Fact]
    public void A_class_that_only_passes_calls_on_is_a_middle_man_a_decorator_is_not()
    {
        var middle = Single(Smells.Value, "middle-man");
        Assert.Equal(new[] { "T:App.Relay", "T:App.Worker" }, middle.Nodes);
        None(Smells.Value, "middle-man", "T:App.LoggingWorker");
    }

    [Fact]
    public void An_interface_nothing_implements_is_reported_one_with_an_implementation_is_not()
    {
        Single(Smells.Value, "unimplemented-interface", "T:App.IPlugin");
        None(Smells.Value, "unimplemented-interface", "T:App.IWorker");
    }

    [Fact]
    public void Unused_members_are_one_finding_per_type()
    {
        var dead = Single(Smells.Value, "dead-code", "T:App.Hidden");
        Assert.Equal("dead-code@T:App.Hidden", dead.Id);
        Assert.Equal(new[] { "T:App.Hidden", "F:App.Hidden._unusedField", "M:App.Hidden.Unused" }, dead.Nodes);
        Assert.Equal(2, dead.Locations.Count);
    }

    // ------------------------------------------------------------------ cycles and hubs

    [Fact]
    public void A_namespace_cycle_names_the_cheapest_cut_and_the_code_behind_it()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/Orders.cs", """
            namespace App.Orders;
            public class Order
            {
                public App.Customers.Customer? Owner;
                public App.Customers.Customer? Backup;
                public void Notify() => Owner!.Tell();
            }
            """);
        ws.File("App/Customers.cs", """
            namespace App.Customers;
            public class Customer
            {
                public void Tell() { }
                public App.Orders.Order? Last;
            }
            """);
        ws.File("App/Billing.cs", "namespace App.Billing; public class Invoice { public App.Orders.Order? Order; }");
        var report = Findings(ws);

        var cycle = Single(report, "cycle.namespace");
        Assert.Equal(FindingSeverity.Warning, cycle.Severity);
        Assert.Equal("cycle.namespace@namespace:App/App.Customers", cycle.Id);
        Assert.Equal(2, cycle.Evidence["size"]);
        Assert.Equal(1, cycle.Evidence["cutDependencies"]);
        Assert.Contains("App.Customers → App.Orders", cycle.Message); // the lighter direction is cut
        Assert.All(cycle.Locations, l => Assert.Equal("App/Customers.cs", l.File));
        Assert.Contains("break-cycle", cycle.ProposalKinds);
        None(report, "cycle.namespace", "namespace:App/App.Billing");
    }

    [Fact]
    public void A_ring_of_eight_types_is_a_tangle_and_an_error()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/Ring.cs", "namespace App;\n" + string.Concat(Enumerable.Range(0, 8).Select(i => $"public class R{i} {{ public R{(i + 1) % 8}? Next; }}\n")));
        var tangle = Single(Findings(ws), "tangle");
        Assert.Equal(FindingSeverity.Error, tangle.Severity);
        Assert.Equal(8, tangle.Evidence["size"]);
        Assert.Equal(1, tangle.Evidence["cutDependencies"]);
    }

    [Fact]
    public void A_type_used_by_many_that_uses_many_is_a_hub()
    {
        using var ws = new TestWorkspace().Project("App");
        var sb = new StringBuilder("namespace App;\n");
        for (var i = 0; i < 12; i++) sb.AppendLine($"public class Dep{i} {{ }}");
        sb.AppendLine("public class Center {" + string.Concat(Enumerable.Range(0, 12).Select(i => $" public Dep{i}? D{i};")) + " }");
        for (var i = 0; i < 15; i++) sb.AppendLine($"public class User{i} {{ public Center? C; }}");
        sb.AppendLine("public class Almost {" + string.Concat(Enumerable.Range(0, 11).Select(i => $" public Dep{i}? D{i};")) + " }");
        for (var i = 0; i < 15; i++) sb.AppendLine($"public class Fan{i} {{ public Almost? A; }}");
        ws.File("App/Hub.cs", sb.ToString());

        var report = Findings(ws);
        var hub = Single(report, "hub");
        Assert.Equal("T:App.Center", hub.Nodes[0]);
        Assert.Equal(15, hub.Evidence["ca"]);
        Assert.Equal(12, hub.Evidence["ce"]);
    }

    // ------------------------------------------------------------------ modules

    [Fact]
    public void Inner_layers_depending_on_outer_ones_break_the_naming_convention()
    {
        using var ws = new TestWorkspace().Project("Shop.Infrastructure").Project("Shop.Domain", references: "Shop.Infrastructure").Project("Shop.Web", references: "Shop.Domain,Shop.Infrastructure");
        ws.File("Shop.Infrastructure/Db.cs", "namespace Shop.Infrastructure; public class Db { public void Save() { } }");
        ws.File("Shop.Domain/Order.cs", "namespace Shop.Domain; public class Order { public void Save(Shop.Infrastructure.Db db) => db.Save(); }");
        ws.File("Shop.Web/Page.cs", "namespace Shop.Web; public class Page { public Shop.Domain.Order? Order; public Shop.Infrastructure.Db? Db; }");
        var report = Findings(ws);

        var violation = Single(report, "layer.convention");
        Assert.Equal("layer.convention@project:Shop.Domain→project:Shop.Infrastructure", violation.Id);
        Assert.Contains("domain layer", violation.Message);
        Assert.Contains(violation.Locations, l => l.File == "Shop.Domain/Order.cs");
        Assert.Contains("invert-dependency", violation.ProposalKinds);
    }

    [Fact]
    public void Production_code_that_uses_test_code_is_an_error()
    {
        using var ws = new TestWorkspace();
        ws.File("App.Tests/App.Tests.csproj", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
              <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
            </Project>
            """);
        ws.File("App.Tests/Builders.cs", "namespace App.Tests; public class OrderBuilder { public int Build() => 1; }");
        ws.Project("App", references: "App.Tests");
        ws.File("App/Service.cs", "namespace App; public class Service { public int Run() => new App.Tests.OrderBuilder().Build(); }");
        var report = Findings(ws);

        var finding = Single(report, "test-dependency");
        Assert.Equal(FindingSeverity.Error, finding.Severity);
        Assert.Equal(new[] { "project:App", "project:App.Tests" }, finding.Nodes);
    }

    [Fact]
    public void A_one_type_namespace_coupled_to_one_sibling_is_tiny_with_a_merge_target()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App.Orders; public class Order { public App.Orders.Pricing.Price? Price; public App.Orders.Lines.Line? Line; }");
        ws.File("App/B.cs", "namespace App.Orders.Pricing; public class Price { public decimal Value; }");
        ws.File("App/C.cs", "namespace App.Orders.Lines; public class Line { } public class LineList { public Line? First; }");
        ws.File("App/D.cs", "namespace App.Reports; public class Report { } public class Chart { public Report? Of; }");
        var report = Findings(ws);

        var tiny = Single(report, "tiny-namespace");
        Assert.Equal(new[] { "namespace:App/App.Orders.Pricing", "namespace:App/App.Orders", "T:App.Orders.Pricing.Price" }, tiny.Nodes);
        Assert.Contains("Move Price into App.Orders", tiny.Suggestion);
    }

    // ------------------------------------------------------------------ DI

    [Fact]
    public void Di_issues_circular_wiring_and_over_injection_are_findings()
    {
        using var ws = new TestWorkspace().Project("App", sdk: "Microsoft.NET.Sdk.Web");
        ws.File("App/Setup.cs", """
            using Microsoft.Extensions.DependencyInjection;
            namespace App;
            public class Db { }
            public class Cache(Db db);
            public class Ping(Pong pong);
            public class Pong(Ping ping);
            public class S1 { } public class S2 { } public class S3 { } public class S4 { } public class S5 { } public class S6 { } public class S7 { }
            public class Busy(S1 a, S2 b, S3 c, S4 d, S5 e, S6 f, S7 g);
            public static class Setup
            {
                public static void Add(IServiceCollection services)
                {
                    services.AddScoped<Db>();
                    services.AddSingleton<Cache>();
                    services.AddTransient<Ping>();
                    services.AddTransient<Pong>();
                    services.AddTransient<S1>(); services.AddTransient<S2>(); services.AddTransient<S3>(); services.AddTransient<S4>();
                    services.AddTransient<S5>(); services.AddTransient<S6>(); services.AddTransient<S7>();
                    services.AddTransient<Busy>();
                }
            }
            """);
        var report = Findings(ws);

        var captive = Single(report, "di.captive");
        Assert.Equal(FindingCategory.Di, captive.Category);
        Assert.Equal(FindingSeverity.Error, captive.Severity);
        Assert.Contains(captive.Locations, l => l.Note?.Contains("registers Db as scoped") == true);
        Assert.Equal(new[] { "T:App.Ping", "T:App.Pong" }, Single(report, "di.circular").Nodes);
        Assert.Equal(7, Single(report, "di.over-injection").Evidence["services"]);
    }

    // ------------------------------------------------------------------ git

    [Fact]
    public void Git_shows_hidden_coupling()
    {
        using var ws = new TestWorkspace().Project("App").Git("init", "-q");
        string Version(string type, int v) => $"namespace App; public class {type} {{ public int V{v} => {v}; }}";
        for (var v = 1; v <= 3; v++) ws.Commit("c" + v, ("App/Rules.cs", Version("Rules", v)), ("App/Format.cs", Version("Format", v)));
        var report = Findings(ws, new AnalyzerOptions());

        var hidden = Single(report, "change-coupling.hidden");
        Assert.Equal("change-coupling.hidden@T:App.Format→T:App.Rules", hidden.Id);
        Assert.Equal(3, hidden.Evidence["sharedCommits"]);
        None(Findings(ws, new AnalyzerOptions(), new FindingOptions { HiddenCouplingMinShared = 4 }), "change-coupling.hidden");
    }

    // ------------------------------------------------------------------ samples, ids, score

    private static readonly Lazy<CodeGraph> Shop = new(() =>
        CodeMapAnalyzer.Analyze(Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln"), LanguageRegistry.BuiltIn, NoGit));

    [Fact]
    public void Shop_findings_match_the_golden_file()
    {
        var report = FindingsAnalysis.Compute(Shop.Value);
        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonExporter.Options) { WriteIndented = true }).ReplaceLineEndings("\n") + "\n";
        var golden = Path.Combine(GoldenTests.RepoRoot(), "tests", "CodeMap.Tests", "Golden", "shop.findings.json");
        if (Environment.GetEnvironmentVariable("CODEMAP_UPDATE_GOLDEN") == "1") File.WriteAllText(golden, json);
        Assert.Equal(File.ReadAllText(golden).ReplaceLineEndings("\n"), json);
    }

    [Fact]
    public void Ids_are_the_same_in_every_analysis_and_every_rule_is_in_the_catalog()
    {
        var first = FindingsAnalysis.Compute(Shop.Value);
        var again = FindingsAnalysis.Compute(CodeMapAnalyzer.Analyze(Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln"), LanguageRegistry.BuiltIn, NoGit));

        Assert.Equal(first.Findings.Select(f => f.Id), again.Findings.Select(f => f.Id));
        Assert.Equal(first.Findings.Count, first.Findings.Select(f => f.Id).Distinct().Count());
        foreach (var finding in first.Findings.Concat(Smells.Value.Findings)) Assert.NotNull(FindingRules.Find(finding.Rule));
        Assert.Equal(FindingRules.All.Count, FindingRules.All.Select(r => r.Id).Distinct().Count());
    }

    [Fact]
    public void Findings_are_ordered_worst_first_and_counted()
    {
        var report = FindingsAnalysis.Compute(Shop.Value);
        var severities = report.Findings.Select(f => FindingSeverity.Order(f.Severity)).ToList();
        Assert.Equal(severities.Order(), severities);
        Assert.Equal(report.Findings.Count, report.BySeverity.Values.Sum());
        Assert.Equal(report.Findings.Count, report.ByCategory.Values.Sum());
    }

    [Fact]
    public void The_health_score_adds_up_its_parts()
    {
        var score = FindingsAnalysis.Compute(Shop.Value).Score;
        Assert.Equal(100, score.Components.Sum(c => c.Weight));
        Assert.Equal((int)Math.Round(100 - score.Components.Sum(c => c.Weight * c.Value)), score.Score);
        Assert.InRange(score.Score, 60, 95);
        Assert.Equal(score.Score >= 85 ? "A" : score.Score >= 70 ? "B" : score.Score >= 55 ? "C" : "D", score.Grade);
        Assert.All(score.Components, c => Assert.False(string.IsNullOrWhiteSpace(c.Explanation)));
        Assert.StartsWith($"{score.Score}/100 ({score.Grade})", score.Summary);
    }

    [Fact]
    public void Test_code_is_left_out_unless_asked_for()
    {
        var withTests = FindingsAnalysis.Compute(Shop.Value, new FindingOptions { IncludeTests = true });
        var without = FindingsAnalysis.Compute(Shop.Value);
        var index = new GraphIndex(Shop.Value);
        Assert.DoesNotContain(without.Findings, f => f.Nodes.Count > 0 && index.Node(f.Nodes[0]) is { } n && index.IsTest(n) && f.Rule != "test-dependency");
        Assert.True(withTests.Findings.Count >= without.Findings.Count);
    }

    [Fact]
    public void The_markdown_report_has_the_score_and_the_findings()
    {
        var markdown = MarkdownReport.Export(Shop.Value);
        Assert.Contains("## Health: ", markdown);
        Assert.Contains("## Findings (", markdown);
        Assert.Contains("`di.captive`", markdown);
    }
}
