using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>Rules of the DI containers other languages bring (NestJS, Angular), on raw DI data as a plugin writes it.</summary>
public class DiRulesTests
{
    private static GraphNode Class(string id, string kind = NodeKinds.Class, string project = "p") => new() { Id = id, Kind = kind, Name = id, Project = project };

    private static DiAnalysis Run(CodeGraph graph, Func<GraphNode, string?>? languageOf = null)
    {
        DependencyInjectionAnalysis.Compute(graph, languageOf);
        return graph.Analysis.Di!;
    }

    [Fact]
    public void Nest_request_scope_spreads_to_everything_that_depends_on_it()
    {
        var graph = new CodeGraph { Nodes = { Class("Ctx"), Class("Service"), Class("Controller"), Class("Other") } };
        graph.Analysis.Di = new DiAnalysis
        {
            Registrations =
            {
                new ServiceRegistration { Service = "Ctx", Lifetime = "scoped", Framework = "nest" },
                new ServiceRegistration { Service = "Service", Lifetime = "singleton", Framework = "nest" },
                new ServiceRegistration { Service = "Controller", Lifetime = "singleton", Kind = "controller", Framework = "nest" },
                new ServiceRegistration { Service = "Other", Lifetime = "singleton", Framework = "nest" },
            },
            Dependencies =
            {
                new DiDependency { Consumer = "Service", Service = "Ctx" },
                new DiDependency { Consumer = "Controller", Service = "Service" },
                new DiDependency { Consumer = "Other", Service = "ConfigService", External = true },
            },
        };

        var di = Run(graph);

        Assert.Equal(new[] { ("scope-bubbling", "info", "Controller", "Service"), ("scope-bubbling", "info", "Service", "Ctx") },
            di.Issues.Select(i => (i.Kind, i.Severity, i.Consumer, i.Service)));
        Assert.Contains("Controller becomes request-scoped because it depends on request-scoped Service", di.Issues[0].Message);
        Assert.DoesNotContain(di.Issues, i => i.Kind.StartsWith("captive")); // not a mistake in Nest
        Assert.Equal(("scoped", "scoped"), (di.Dependencies.Single(d => d.Consumer == "Controller").ConsumerLifetime, di.Dependencies.Single(d => d.Consumer == "Controller").Lifetime));
        Assert.Equal("nest", di.Dependencies[0].Framework);
        Assert.Equal(new[] { null, "scoped", "scoped", null }, di.Registrations.Select(r => r.Effective));
        Assert.True(graph.Node("Service").HasTag("scoped") && !graph.Node("Service").HasTag("singleton"));
        Assert.Equal("singleton", di.Dependencies.Single(d => d.Consumer == "Other").Lifetime); // a known Nest service
    }

    [Fact]
    public void Nest_cannot_inject_an_interface_without_a_token()
    {
        var graph = new CodeGraph { Nodes = { Class("Service"), Class("IRepo", NodeKinds.Interface), Class("Missing") } };
        graph.Analysis.Di = new DiAnalysis
        {
            Registrations = { new ServiceRegistration { Service = "Service", Lifetime = "singleton", Framework = "nest" } },
            Dependencies = { new DiDependency { Consumer = "Service", Service = "IRepo" }, new DiDependency { Consumer = "Service", Service = "Missing" } },
        };

        var di = Run(graph);

        Assert.Equal(new[] { "interface-injection", "unregistered" }, di.Issues.Select(i => i.Kind).Order());
        Assert.Contains("use @Inject(TOKEN)", di.Issues.Single(i => i.Kind == "interface-injection").Message);
    }

    [Fact]
    public void Angular_root_services_cannot_get_what_only_components_provide()
    {
        var graph = new CodeGraph { Nodes = { Class("Store"), Class("Panel"), Class("Local"), Class("Api") } };
        graph.Analysis.Di = new DiAnalysis
        {
            Registrations =
            {
                new ServiceRegistration { Service = "Store", Lifetime = "singleton", Framework = "angular" },
                new ServiceRegistration { Service = "Api", Lifetime = "singleton", Framework = "angular" },
                new ServiceRegistration { Service = "Panel", Lifetime = "transient", Kind = "component", Framework = "angular" },
                new ServiceRegistration { Service = "Local", Lifetime = "scoped", RegisteredIn = "Panel", Framework = "angular" },
            },
            Dependencies =
            {
                new DiDependency { Consumer = "Store", Service = "Local" },
                new DiDependency { Consumer = "Store", Service = "Api" },
                new DiDependency { Consumer = "Panel", Service = "Local" },
                new DiDependency { Consumer = "Panel", Service = "HttpClient", External = true },
            },
        };

        var di = Run(graph);

        var issue = Assert.Single(di.Issues);
        Assert.Equal(("unreachable", "error", "Store", "Local"), (issue.Kind, issue.Severity, issue.Consumer, issue.Service));
        Assert.Equal("singleton", di.Dependencies.Single(d => d.Service == "HttpClient").Lifetime);
    }

    [Fact]
    public void Each_container_keeps_its_own_rules_in_one_map()
    {
        var graph = new CodeGraph { Nodes = { Class("A"), Class("B"), Class("C"), Class("D") } };
        graph.Analysis.Di = new DiAnalysis
        {
            Registrations =
            {
                new ServiceRegistration { Service = "C", Lifetime = "scoped", Framework = "nest" },
                new ServiceRegistration { Service = "D", Lifetime = "singleton", Framework = "nest" },
                new ServiceRegistration { Service = "A", Lifetime = "singleton" },
                new ServiceRegistration { Service = "B", Lifetime = "scoped" },
            },
            Dependencies = { new DiDependency { Consumer = "A", Service = "B" }, new DiDependency { Consumer = "D", Service = "C" } },
        };

        var di = Run(graph);

        Assert.Equal(new[] { "A", "B", "C", "D" }, di.Registrations.Select(r => r.Service)); // .NET's first
        Assert.Equal(new[] { ("captive", "A"), ("scope-bubbling", "D") }, di.Issues.Select(i => (i.Kind, i.Consumer)));
    }

    [Fact]
    public void Dotnet_conventions_apply_to_csharp_code_only()
    {
        var csharp = new GraphNode { Id = "T:Api.OrdersController", Kind = NodeKinds.Class, Name = "OrdersController", Project = "project:Api", Tags = new() { Tags.Controller } };
        var typescript = new GraphNode { Id = "ts:api:orders.routes.ts", Kind = NodeKinds.Module, Level = NodeLevels.Type, Name = "orders.routes.ts", Project = "ts:project:api", Tags = new() { Tags.Controller } };
        var graph = new CodeGraph { Nodes = { csharp, typescript } };
        graph.Analysis.Di = new DiAnalysis
        {
            Dependencies =
            {
                new DiDependency { Consumer = csharp.Id, Service = "Missing" },
                new DiDependency { Consumer = typescript.Id, Service = "Missing" },
            },
        };

        var di = Run(graph, n => n.Project == "ts:project:api" ? "typescript" : "csharp");

        Assert.Equal(new[] { csharp.Id }, di.Dependencies.Select(d => d.Consumer)); // ASP.NET creates the C# controller, nothing creates the file
    }
}
