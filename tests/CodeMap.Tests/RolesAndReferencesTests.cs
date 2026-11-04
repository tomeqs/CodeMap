using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>Overloads the compiler could not pick, explicit interface implementations, and roles that need evidence.</summary>
public class RolesAndReferencesTests
{
    [Fact]
    public void When_overload_resolution_fails_the_overload_that_fits_the_arguments_is_called()
    {
        // No implicit usings: Action and Exception do not resolve, so the compiler cannot pick an overload for the lambdas.
        using var ws = new TestWorkspace()
            .File("Ovl/Ovl.csproj", """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>""")
            .File("Ovl/S.cs", """
                namespace Ovl;
                public static class S
                {
                    public static int Retry(this string b) => b.Retry(1);
                    public static int Retry(this string b, int n) => b.Retry(n, (x, y) => { });
                    public static int Retry(this string b, int n, Action<Exception, int> onRetry) => b.Retry(n, (x, y, z) => onRetry(x, y));
                    public static int Retry(this string b, int n, Action<Exception, int, object> onRetry) => n;
                }
                """);

        var graph = ws.Analyze();
        string[] Calls(string from) => graph.Edges.Where(e => e.Source == from && e.Kind == EdgeKinds.Calls).Select(e => e.Target).ToArray();
        Assert.Equal(new[] { "M:Ovl.S.Retry(System.String,System.Int32)" }, Calls("M:Ovl.S.Retry(System.String)"));
        Assert.Equal(new[] { "M:Ovl.S.Retry(System.String,System.Int32,Action{Exception,System.Int32})" }, Calls("M:Ovl.S.Retry(System.String,System.Int32)")); // the lambda has 2 parameters
        Assert.Equal(new[] { "M:Ovl.S.Retry(System.String,System.Int32,Action{Exception,System.Int32,System.Object})" }, Calls("M:Ovl.S.Retry(System.String,System.Int32,Action{Exception,System.Int32})"));
    }

    [Fact]
    public void Explicit_implementations_of_external_interfaces_are_not_unused()
    {
        using var ws = new TestWorkspace()
            .Project("Expl")
            .File("Expl/Bag.cs", """
                using System.Collections;
                namespace Expl;
                internal sealed class Bag : IEnumerable<int>, IDisposable
                {
                    private readonly List<int> _items = new();
                    public IEnumerator<int> GetEnumerator() => _items.GetEnumerator();
                    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
                    void IDisposable.Dispose() { }
                    private void Forgotten() { }
                }
                public static class Use { public static int Count() { using var bag = new Bag(); return bag.Count(); } }
                """);

        Assert.Equal(new[] { "M:Expl.Bag.Forgotten" }, ws.Analyze().Analysis.UnusedCandidates);
    }

    [Fact]
    public void A_name_ending_in_Controller_is_not_a_controller_without_evidence()
    {
        // As in Polly: circuit "controllers" in a library are neither ASP.NET controllers nor DI consumers.
        using var ws = new TestWorkspace()
            .Project("Lib")
            .File("Lib/Circuit.cs", """
                namespace Lib;
                public interface ICircuitController { void Trip(); }
                public sealed class CircuitStateController : ICircuitController
                {
                    public CircuitStateController(TimeProvider time) { }
                    public void Trip() { }
                }
                public sealed class RequestTimingMiddleware { }
                """)
            .Project("Web", sdk: "Microsoft.NET.Sdk.Web")
            .File("Web/OrdersController.cs", """
                using Microsoft.AspNetCore.Mvc;
                namespace Web;
                public interface IOrders { }
                public sealed class OrdersController(IOrders orders) : ControllerBase { }
                [ApiController] public sealed class StatusController(IOrders orders) { }
                """);

        var graph = ws.Analyze();
        Assert.Null(graph.Node("T:Lib.CircuitStateController").Tags);
        Assert.Null(graph.Node("T:Lib.ICircuitController").Tags);
        Assert.Null(graph.Node("T:Lib.RequestTimingMiddleware").Tags);
        Assert.Contains(Tags.Controller, graph.Node("T:Web.OrdersController").Tags!);
        Assert.Contains(Tags.Controller, graph.Node("T:Web.StatusController").Tags!);
        // Only the real controllers ask the container for anything.
        Assert.Equal(new[] { "T:Web.OrdersController", "T:Web.StatusController" },
            graph.Analysis.Di!.Issues.Where(i => i.Kind == "unregistered").Select(i => i.Consumer).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Razor_pages_and_blazor_components_are_consumers_and_their_members_are_used_from_markup()
    {
        using var ws = new TestWorkspace()
            .Project("Web", sdk: "Microsoft.NET.Sdk.Web")
            .File("Web/Services.cs", "namespace Web;\npublic interface ICatalog { }\npublic interface IClock { }\n")
            .File("Web/Pages/Index.cshtml", "@page\n@model Web.Pages.IndexModel\n")
            .File("Web/Pages/Index.cshtml.cs", """
                using Microsoft.AspNetCore.Mvc.RazorPages;
                namespace Web.Pages;
                public class IndexModel(ICatalog catalog) : PageModel
                {
                    public void OnGet() { }
                    private void Refresh() { }
                }
                """)
            .File("Web/Components/List.razor", "<button @onclick=\"CreateClick\">New</button>\n")
            .File("Web/Components/List.razor.cs", """
                using Microsoft.AspNetCore.Components;
                namespace Web.Components;
                public partial class List
                {
                    [Inject] public IClock Clock { get; set; } = default!;
                    private void CreateClick() { }
                }
                """);

        var graph = ws.Analyze();
        Assert.Contains(Tags.Page, graph.Node("T:Web.Pages.IndexModel").Tags!);
        Assert.DoesNotContain(Tags.Dto, graph.Node("T:Web.Pages.IndexModel").Tags!); // not a "dto" because of its name
        Assert.Contains(Tags.Component, graph.Node("T:Web.Components.List").Tags!);
        var di = graph.Analysis.Di!;
        Assert.Contains(di.Dependencies, d => d is { Consumer: "T:Web.Pages.IndexModel", Service: "T:Web.ICatalog" });
        Assert.Contains(di.Dependencies, d => d is { Consumer: "T:Web.Components.List", Service: "T:Web.IClock" }); // [Inject]
        Assert.Equal(new[] { "T:Web.Components.List", "T:Web.Pages.IndexModel" },
            di.Issues.Where(i => i.Kind == "unregistered").Select(i => i.Consumer).Order(StringComparer.Ordinal));
        Assert.DoesNotContain(graph.Analysis.UnusedCandidates, id => id.Contains("Refresh") || id.Contains("CreateClick"));
    }
}
