using CodeMap.Model;

namespace CodeMap.Tests;

public class AnalyzerTests
{
    [Fact]
    public void Records_type_hierarchy_at_type_and_member_level()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Shapes.cs", """
                namespace App;
                public interface IShape { double Area(); }
                public abstract class Shape : IShape
                {
                    public abstract double Area();
                    public virtual string Describe() => "shape";
                }
                public sealed class Circle : Shape
                {
                    public double R { get; init; }
                    public override double Area() => Math.PI * R * R;
                    public override string Describe() => "circle";
                }
                """);

        var graph = ws.Analyze();

        graph.AssertEdge("T:App.Shape", EdgeKinds.Implements, "T:App.IShape");
        graph.AssertEdge("T:App.Circle", EdgeKinds.Inherits, "T:App.Shape");
        graph.AssertEdge("M:App.Shape.Area", EdgeKinds.Implements, "M:App.IShape.Area");
        graph.AssertEdge("M:App.Circle.Area", EdgeKinds.Overrides, "M:App.Shape.Area");
        graph.AssertEdge("M:App.Circle.Describe", EdgeKinds.Overrides, "M:App.Shape.Describe");
        graph.AssertEdge("M:App.Circle.Area", EdgeKinds.Accesses, "P:App.Circle.R");

        var circle = graph.Node("T:App.Circle");
        Assert.Equal(NodeKinds.Class, circle.Kind);
        Assert.Equal("App.Shape", circle.BaseType);
        Assert.Contains("sealed", circle.Modifiers!);
        Assert.Equal(2, circle.Metric("dit"));
        Assert.Equal("namespace:App/App", circle.Parent);
        Assert.Equal("project:App", circle.Project);
        Assert.Equal("App/Shapes.cs", circle.Location!.File);
    }

    [Fact]
    public void Records_behaviour_from_method_bodies()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Code.cs", """
                namespace App;
                public class NotFound : Exception { }
                public class Repo
                {
                    public event EventHandler? Changed;
                    public string? Find(int id) => id > 0 ? "x" : null;
                    public void Touch() => Changed?.Invoke(this, EventArgs.Empty);
                }
                public class Service
                {
                    private readonly Repo _repo = new Repo();
                    public Service() { _repo.Changed += OnChanged; }
                    public string Get(int id)
                    {
                        try { return _repo.Find(id) ?? throw new NotFound(); }
                        catch (NotFound) { return Helpers.Fallback(); }
                    }
                    private void OnChanged(object? s, EventArgs e) { }
                }
                public static class Helpers { public static string Fallback() => "?"; }
                """);

        var graph = ws.Analyze();

        graph.AssertEdge("M:App.Service.Get(System.Int32)", EdgeKinds.Calls, "M:App.Repo.Find(System.Int32)");
        graph.AssertEdge("M:App.Service.Get(System.Int32)", EdgeKinds.Calls, "M:App.Helpers.Fallback");
        graph.AssertEdge("M:App.Service.Get(System.Int32)", EdgeKinds.Throws, "T:App.NotFound");
        graph.AssertEdge("M:App.Service.Get(System.Int32)", EdgeKinds.Catches, "T:App.NotFound");
        graph.AssertEdge("M:App.Service.Get(System.Int32)", EdgeKinds.Accesses, "F:App.Service._repo");
        graph.AssertEdge("F:App.Service._repo", EdgeKinds.Instantiates, "T:App.Repo");
        graph.AssertEdge("F:App.Service._repo", EdgeKinds.Holds, "T:App.Repo");
        graph.AssertEdge("M:App.Service.#ctor", EdgeKinds.Subscribes, "E:App.Repo.Changed");
        graph.AssertEdge("M:App.Service.#ctor", EdgeKinds.Calls, "M:App.Service.OnChanged(System.Object,System.EventArgs)");
        graph.AssertEdge("M:App.Repo.Touch", EdgeKinds.Accesses, "E:App.Repo.Changed");
        // "throw new" is not also an instantiation
        graph.AssertNoEdge("M:App.Service.Get(System.Int32)", EdgeKinds.Instantiates, "T:App.NotFound");
        Assert.Contains(Tags.Exception, graph.Node("T:App.NotFound").Tags!);
    }

    [Fact]
    public void Calls_and_instantiations_remember_the_line_of_their_first_occurrence()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Flow.cs", """
                namespace App;
                public class Line { public void Add() { } }
                public class Flow
                {
                    public void Run()
                    {
                        Second();
                        var line = new Line();
                        First();
                        line.Add();
                        Second();
                    }

                    void First() { }
                    void Second() { }
                }
                """);

        var graph = ws.Analyze();

        int LineOf(string target, string kind) => graph.Edges.Single(e => e.Source == "M:App.Flow.Run" && e.Target == target && e.Kind == kind).Line;
        Assert.Equal(7, LineOf("M:App.Flow.Second", EdgeKinds.Calls)); // first of two call sites
        Assert.Equal(8, LineOf("T:App.Line", EdgeKinds.Instantiates));
        Assert.Equal(9, LineOf("M:App.Flow.First", EdgeKinds.Calls));
        Assert.Equal(10, LineOf("M:App.Line.Add", EdgeKinds.Calls));
        Assert.Equal(2, graph.Edges.Single(e => e.Source == "M:App.Flow.Run" && e.Target == "M:App.Flow.Second").Weight);
        Assert.All(graph.Edges.Where(e => e.Kind is EdgeKinds.Holds or EdgeKinds.Accepts), e => Assert.Equal(0, e.Line));
    }

    [Fact]
    public void Records_dependency_injection_signatures_and_records()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Di.cs", """
                namespace App;
                public interface IClock { DateTime Now { get; } }
                public interface IStore<T> { T? Load(Guid id); }
                public record Invoice(Guid Id, decimal Amount, Customer Customer);
                public record Customer(string Name);
                public class Billing(IClock clock)
                {
                    public DateTime Stamp() => clock.Now;
                }
                public class InvoiceService
                {
                    private readonly IStore<Invoice> _store;
                    public InvoiceService(IStore<Invoice> store, IClock clock) => _store = store;
                    public Invoice? Find(Guid id) => _store.Load(id);
                    public List<Customer> Customers(IEnumerable<Invoice> invoices) => invoices.Select(i => i.Customer).ToList();
                }
                """);

        var graph = ws.Analyze();

        graph.AssertEdge("T:App.Billing", EdgeKinds.Injects, "T:App.IClock");
        graph.AssertEdge("T:App.InvoiceService", EdgeKinds.Injects, "T:App.IStore`1");
        graph.AssertEdge("T:App.InvoiceService", EdgeKinds.Injects, "T:App.IClock");
        graph.AssertEdge("T:App.InvoiceService", EdgeKinds.Uses, "T:App.Invoice"); // generic argument of an injected service
        graph.AssertEdge("M:App.Billing.Stamp", EdgeKinds.Accesses, "P:App.IClock.Now");
        graph.AssertEdge("M:App.InvoiceService.Find(System.Guid)", EdgeKinds.Returns, "T:App.Invoice");
        graph.AssertEdge("M:App.InvoiceService.Find(System.Guid)", EdgeKinds.Calls, "M:App.IStore`1.Load(System.Guid)");
        graph.AssertEdge("M:App.InvoiceService.Customers(System.Collections.Generic.IEnumerable{App.Invoice})", EdgeKinds.Returns, "T:App.Customer");
        graph.AssertEdge("M:App.InvoiceService.Customers(System.Collections.Generic.IEnumerable{App.Invoice})", EdgeKinds.Accepts, "T:App.Invoice");
        graph.AssertEdge("F:App.InvoiceService._store", EdgeKinds.Holds, "T:App.IStore`1");

        // Positional record parameters become property nodes that hold their types.
        Assert.Equal(NodeKinds.Record, graph.Node("T:App.Invoice").Kind);
        Assert.Equal(NodeKinds.Property, graph.Node("P:App.Invoice.Customer").Kind);
        graph.AssertEdge("P:App.Invoice.Customer", EdgeKinds.Holds, "T:App.Customer");
    }

    [Fact]
    public void Merges_partial_types_and_handles_extension_methods_and_top_level_statements()
    {
        using var ws = new TestWorkspace()
            .Project("App", extra: "<OutputType>Exe</OutputType>")
            .File("App/Program.cs", """
                using App;
                var p = new Person("Ada");
                Console.WriteLine(p.Greet().Shout());
                """)
            .File("App/Person.cs", """
                namespace App;
                public partial class Person(string name)
                {
                    public string Name { get; } = name;
                }
                """)
            .File("App/Person.Greeting.cs", """
                namespace App;
                public partial class Person
                {
                    public string Greet() => "Hi " + Name;
                }
                public static class StringExtensions
                {
                    public static string Shout(this string text) => text.ToUpperInvariant() + "!";
                }
                public static class PersonExtensions
                {
                    public static bool IsAda(this Person person) => person.Name == "Ada";
                }
                """);

        var graph = ws.Analyze();

        var person = graph.Node("T:App.Person");
        Assert.Contains("partial", person.Modifiers!);
        Assert.Single(person.ExtraLocations!);
        Assert.Equal(new[] { "App/Person.Greeting.cs", "App/Person.cs" }, new[] { person.Location!.File, person.ExtraLocations![0].File }.Order(StringComparer.Ordinal));

        graph.AssertEdge("M:App.PersonExtensions.IsAda(App.Person)", EdgeKinds.Extends, "T:App.Person");
        Assert.Contains(Tags.Extensions, graph.Node("T:App.PersonExtensions").Tags!);

        var main = graph.Nodes.Single(n => n.Kind == NodeKinds.Method && n.HasTag(Tags.EntryPoint));
        graph.AssertEdge(main.Id, EdgeKinds.Instantiates, "T:App.Person");
        graph.AssertEdge(main.Id, EdgeKinds.Calls, "M:App.Person.Greet");
        graph.AssertEdge(main.Id, EdgeKinds.Calls, "M:App.StringExtensions.Shout(System.String)");
    }

    [Fact]
    public void Analyzes_multiple_projects_with_references_and_disambiguates_ids()
    {
        using var ws = new TestWorkspace()
            .Project("Core")
            .Project("Web", references: "Core")
            .File("Core/Model.cs", """
                namespace Shared;
                public class Model { public int Value { get; set; } }
                public class Helper { public static int Twice(int x) => x * 2; }
                public class Util { }
                """)
            .File("Web/Page.cs", """
                namespace Web;
                public class Page
                {
                    public int Render(Shared.Model m) => Shared.Helper.Twice(m.Value);
                }
                """)
            .File("Web/Dup.cs", """
                namespace Shared;
                public class Util { }
                """);

        var graph = ws.Analyze();

        graph.AssertEdge("project:Web", EdgeKinds.ProjectReference, "project:Core");
        graph.AssertEdge("M:Web.Page.Render(Shared.Model)", EdgeKinds.Calls, "M:Shared.Helper.Twice(System.Int32)");
        graph.AssertEdge("M:Web.Page.Render(Shared.Model)", EdgeKinds.Accesses, "P:Shared.Model.Value");
        graph.AssertEdge("M:Web.Page.Render(Shared.Model)", EdgeKinds.Accepts, "T:Shared.Model");

        // Same full name in two assemblies: the first project keeps the plain id.
        Assert.Equal("project:Core", graph.Node("T:Shared.Util").Project);
        Assert.Equal("project:Web", graph.Node("T:Shared.Util@Web").Project);

        Assert.Equal(1, graph.Node("project:Core").Metric("ca"));
        Assert.Equal(1, graph.Node("project:Web").Metric("ce"));
    }

    [Fact]
    public void Detects_cycles_unused_code_and_computes_metrics()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/A.cs", """
                namespace App.First;
                public class A
                {
                    public App.Second.B? Partner { get; set; }
                    public int Branchy(int x)
                    {
                        if (x > 10 && x < 20) return 1;
                        for (var i = 0; i < x; i++) { if (i % 2 == 0) continue; }
                        return x switch { 1 => 1, 2 => 2, _ => (int?)x ?? 0 };
                    }
                    private void NeverCalled() { }
                    private void Used() { }
                    public void Caller() => Used();
                }
                internal class Orphan { }
                """)
            .File("App/B.cs", """
                namespace App.Second;
                public class B { public App.First.A? Partner { get; set; } }
                """);

        var graph = ws.Analyze();

        Assert.Contains(graph.Analysis.Cycles, c => c.Level == "type" && c.Nodes.SequenceEqual(new[] { "T:App.First.A", "T:App.Second.B" }));
        Assert.Contains(graph.Analysis.Cycles, c => c.Level == "namespace");
        Assert.Contains(Tags.InCycle, graph.Node("T:App.First.A").Tags!);

        Assert.Contains("M:App.First.A.NeverCalled", graph.Analysis.UnusedCandidates);
        Assert.Contains("T:App.First.Orphan", graph.Analysis.UnusedCandidates);
        Assert.DoesNotContain("M:App.First.A.Used", graph.Analysis.UnusedCandidates);

        // 1 + if + && + for + if + 3 switch arms + ?? = 9
        Assert.Equal(9, graph.Node("M:App.First.A.Branchy(System.Int32)").Metric("complexity"));
        Assert.Equal(1, graph.Node("T:App.First.A").Metric("ce"));
        Assert.Equal(1, graph.Node("T:App.First.A").Metric("ca"));
        Assert.Equal(0.5, graph.Node("T:App.First.A").Metric("instability"));
    }

    [Fact]
    public void Includes_external_types_on_request()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Svc.cs", """
                namespace App;
                public class Svc : IDisposable
                {
                    private readonly HttpClient _http = new();
                    public void Dispose() => _http.CancelPendingRequests();
                }
                """);

        var without = ws.Analyze();
        Assert.DoesNotContain(without.Nodes, n => n.External && n.Kind != NodeKinds.Package);

        var with = ws.Analyze(options: new Analysis.AnalyzerOptions { Git = false, IncludeExternal = true });
        var http = with.Node("T:System.Net.Http.HttpClient");
        Assert.True(http.External);
        Assert.StartsWith("assembly:", http.Parent);
        with.AssertEdge("T:App.Svc", EdgeKinds.Implements, "T:System.IDisposable");
        with.AssertEdge("F:App.Svc._http", EdgeKinds.Holds, "T:System.Net.Http.HttpClient");
        with.AssertEdge("M:App.Svc.Dispose", EdgeKinds.Calls, "T:System.Net.Http.HttpClient");
    }

    [Fact]
    public void Recognises_roles()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Roles.cs", """
                namespace App;
                public class OrderRepository { }
                public interface IPaymentService { }
                public class ShopOptions { }
                public class MyAttribute : Attribute { }
                public class OrderTests
                {
                    [Fact] public void Works() { }
                }
                """);

        var graph = ws.Analyze();

        Assert.Contains(Tags.Repository, graph.Node("T:App.OrderRepository").Tags!);
        Assert.Contains(Tags.Service, graph.Node("T:App.IPaymentService").Tags!);
        Assert.Contains(Tags.Options, graph.Node("T:App.ShopOptions").Tags!);
        Assert.Contains(Tags.Attribute, graph.Node("T:App.MyAttribute").Tags!);
        // [Fact] does not resolve without xunit, the attribute name is still enough.
        Assert.Contains(Tags.Test, graph.Node("T:App.OrderTests").Tags!);
        Assert.Contains(Tags.Test, graph.Node("M:App.OrderTests.Works").Tags!);
    }

    [Fact]
    public void Generic_arguments_of_base_types_and_interfaces_are_dependencies()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Code.cs", """
                namespace App;
                public class Order { }
                public class Line { }
                public interface IRepository<T> { }
                public abstract class Validator<T> { }
                public interface IOrderRepository : IRepository<Order> { }
                public class OrderValidator : Validator<Order>, IRepository<List<Line>> { }
                public class Node : IComparable<Node> { public int CompareTo(Node? other) => 0; }
                """);

        var graph = ws.Analyze();

        graph.AssertEdge("T:App.IOrderRepository", EdgeKinds.Uses, "T:App.Order");
        graph.AssertEdge("T:App.IOrderRepository", EdgeKinds.Inherits, "T:App.IRepository`1"); // an interface extending an interface
        graph.AssertEdge("T:App.OrderValidator", EdgeKinds.Uses, "T:App.Order");
        graph.AssertEdge("T:App.OrderValidator", EdgeKinds.Uses, "T:App.Line");
        graph.AssertEdge("T:App.OrderValidator", EdgeKinds.Inherits, "T:App.Validator`1");
        graph.AssertNoEdge("T:App.Node", EdgeKinds.Uses, "T:App.Node");
    }

    [Fact]
    public void Nameof_mentions_a_member_without_calling_it_and_property_patterns_read_properties()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Code.cs", """
                namespace App;
                public enum Status { Open, Paid }
                public class Order { internal Status Status { get; set; } }
                public class Orders
                {
                    public string GetById(int id) => id.ToString();
                    public string Create() => nameof(GetById) + nameof(Order);
                    public bool IsPaid(Order order) => order is { Status: Status.Paid };
                }
                """);

        var graph = ws.Analyze();

        graph.AssertNoEdge("M:App.Orders.Create", EdgeKinds.Calls, "M:App.Orders.GetById(System.Int32)");
        graph.AssertEdge("M:App.Orders.Create", EdgeKinds.Uses, "T:App.Order");
        graph.AssertEdge("M:App.Orders.IsPaid(App.Order)", EdgeKinds.Accesses, "P:App.Order.Status");
        Assert.DoesNotContain(Tags.Unused, graph.Node("P:App.Order.Status").Tags ?? new List<string>());
    }

    [Theory]
    [InlineData("net8.0", "NETCOREAPP2_1_OR_GREATER")]
    [InlineData("net8.0", "NET5_0_OR_GREATER")]
    [InlineData("netstandard2.1", "NETSTANDARD2_0_OR_GREATER")]
    [InlineData("netstandard2.1", "NETSTANDARD2_1")]
    [InlineData("netcoreapp3.1", "NETCOREAPP2_2_OR_GREATER")]
    [InlineData("net472", "NET462_OR_GREATER")]
    [InlineData("net48", "NETFRAMEWORK")]
    public void The_sdk_preprocessor_symbols_of_the_target_framework_are_defined(string tfm, string symbol)
    {
        var symbols = CodeMap.Loading.CompilationFactory.PreprocessorSymbols(new CodeMap.Loading.ProjectInfo { TargetFramework = tfm }).ToList();
        Assert.Contains(symbol, symbols);
    }

    [Fact]
    public void Code_under_an_or_greater_symbol_of_the_target_framework_is_analyzed()
    {
        using var ws = new TestWorkspace()
            .File("Lib/Lib.csproj", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>netstandard2.1</TargetFramework></PropertyGroup>
                </Project>
                """)
            .File("Lib/Code.cs", """
                namespace Lib;
                #if NETSTANDARD2_0_OR_GREATER
                public class Modern { }
                #else
                public class Legacy { }
                #endif
                """);

        var graph = ws.Analyze();

        Assert.Contains(graph.Nodes, n => n.Id == "T:Lib.Modern");
        Assert.DoesNotContain(graph.Nodes, n => n.Id == "T:Lib.Legacy");
    }
}
