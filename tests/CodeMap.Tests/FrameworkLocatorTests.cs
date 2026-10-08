using CodeMap.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeMap.Tests;

public class FrameworkLocatorTests
{
    [Fact]
    public void Installed_runtime_is_the_newest_stable_version_across_installations()
    {
        using var ws = new TestWorkspace();
        ws.File("a/shared/Microsoft.NETCore.App/8.0.31/System.Runtime.dll", "")
          .File("a/shared/Microsoft.NETCore.App/10.0.0-preview.7/System.Runtime.dll", "")
          .File("b/shared/Microsoft.NETCore.App/10.0.0/System.Runtime.dll", "")
          .File("b/shared/Microsoft.NETCore.App/11.0.0/readme.txt", ""); // incomplete folder
        var roots = new[] { Path.Combine(ws.Root, "missing"), Path.Combine(ws.Root, "a"), Path.Combine(ws.Root, "b") };

        var runtime = FrameworkLocator.FindInstalledRuntime(roots);

        Assert.Equal(Path.Combine(ws.Root, "b", "shared", "Microsoft.NETCore.App", "10.0.0"), runtime);
        Assert.Null(FrameworkLocator.FindInstalledRuntime(new[] { Path.Combine(ws.Root, "missing") }));
    }

    [Fact]
    public void Bundled_references_compile_everyday_and_aspnet_code()
    {
        var tree = CSharpSyntaxTree.ParseText("""
            using System.Text.Json;
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Mvc;
            using Microsoft.Extensions.DependencyInjection;

            public class OrdersController : ControllerBase
            {
                [HttpGet] public IActionResult Get() => Ok(JsonSerializer.Serialize(new System.Collections.Generic.List<int> { 1 }));

                public static void Configure(WebApplicationBuilder builder) => builder.Services.AddScoped<OrdersController>();
            }
            """);

        var compilation = CSharpCompilation.Create("probe", new[] { tree }, FrameworkLocator.BundledReferences.Select(r => r.Reference),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        Assert.Empty(compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
    }
}
