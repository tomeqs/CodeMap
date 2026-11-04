using CodeMap.Loading;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>Project files as MSBuild reads them: imports, Directory.Build.props/targets, central versions, frameworks.</summary>
public class ProjectLoadingTests
{
    [Fact]
    public void Imports_and_directory_build_targets_give_their_properties_usings_and_packages()
    {
        // As in Polly: Directory.Build.props imports eng/Common.props (ImplicitUsings, the framework), Directory.Build.targets
        // adds a global using and, for test projects, imports eng/Test.targets with the test packages.
        using var ws = new TestWorkspace()
            .File("Directory.Build.props", """
                <Project>
                  <Import Project="eng/Common.props" />
                  <PropertyGroup><LangVersion>latest</LangVersion></PropertyGroup>
                </Project>
                """)
            .File("eng/Common.props", """
                <Project>
                  <PropertyGroup>
                    <TargetFramework>net8.0</TargetFramework>
                    <ImplicitUsings>enable</ImplicitUsings>
                  </PropertyGroup>
                </Project>
                """)
            .File("Directory.Build.targets", """
                <Project>
                  <Import Project="$(MSBuildThisFileDirectory)eng/Test.targets" Condition="Exists('$(MSBuildThisFileDirectory)eng/Test.targets') and '$(IsTest)' == 'true'" />
                  <ItemGroup><Using Include="Other.Sub" /></ItemGroup>
                </Project>
                """)
            .File("eng/Test.targets", """<Project><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.0.0" /></ItemGroup></Project>""")
            .File("src/Lib/Lib.csproj", """<Project Sdk="Microsoft.NET.Sdk" />""")
            .File("src/Lib/A.cs", """
                namespace Lib;
                public class A
                {
                    public async Task RunAsync(TimeSpan delay, CancellationToken ct)
                    {
                        await Task.Delay(delay, ct);
                        Helper.Help();
                    }
                }
                """)
            .File("src/Lib/Helper.cs", "namespace Other.Sub;\npublic static class Helper { public static void Help() { } }\n")
            .File("src/Lib.Tests/Lib.Tests.csproj", """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTest>true</IsTest></PropertyGroup></Project>""");

        var lib = ProjectLoader.ReadProject(Path.Combine(ws.Root, "src", "Lib", "Lib.csproj"));
        Assert.Equal(("net8.0", true), (lib.TargetFramework, lib.ImplicitUsings));
        Assert.Contains("Other.Sub", lib.Usings);
        Assert.False(lib.IsTestProject);
        Assert.True(ProjectLoader.ReadProject(Path.Combine(ws.Root, "src", "Lib.Tests", "Lib.Tests.csproj")).IsTestProject);

        var graph = ws.Analyze(Path.Combine(ws.Root, "src", "Lib", "Lib.csproj"));
        const string run = "M:Lib.A.RunAsync(System.TimeSpan,System.Threading.CancellationToken)"; // the framework types resolve
        graph.AssertEdge(run, EdgeKinds.Calls, "M:Other.Sub.Helper.Help");
    }

    [Fact]
    public void A_props_file_can_import_the_one_above_it_with_GetPathOfFileAbove()
    {
        using var ws = new TestWorkspace()
            .File("Directory.Build.props", "<Project><PropertyGroup><DefineConstants>$(DefineConstants);OUTER</DefineConstants></PropertyGroup></Project>")
            .File("sub/Directory.Build.props", """
                <Project>
                  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />
                  <PropertyGroup>
                    <DefineConstants>$(DefineConstants);INNER</DefineConstants>
                    <AssemblyName>Inner.$(MSBuildProjectName)</AssemblyName>
                  </PropertyGroup>
                </Project>
                """)
            .File("sub/App/App.csproj", """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>""");

        var app = ProjectLoader.ReadProject(Path.Combine(ws.Root, "sub", "App", "App.csproj"));
        Assert.Contains("OUTER", app.DefineConstants);
        Assert.Contains("INNER", app.DefineConstants);
        Assert.Equal("Inner.App", app.AssemblyName);
    }

    [Fact]
    public void Only_the_nearest_directory_build_props_is_read_unless_it_imports_the_outer_one()
    {
        using var ws = new TestWorkspace()
            .File("Directory.Build.props", "<Project><PropertyGroup><DefineConstants>OUTER</DefineConstants></PropertyGroup></Project>")
            .File("sub/Directory.Build.props", "<Project><PropertyGroup><AssemblyName>Inner</AssemblyName></PropertyGroup></Project>")
            .File("sub/App/App.csproj", """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>""");

        var app = ProjectLoader.ReadProject(Path.Combine(ws.Root, "sub", "App", "App.csproj"));
        Assert.Equal("Inner", app.AssemblyName);
        Assert.DoesNotContain("OUTER", app.DefineConstants); // MSBuild imports only the nearest one
    }

    [Fact]
    public void Central_package_versions_come_from_directory_packages_props()
    {
        using var ws = new TestWorkspace()
            .File("Directory.Packages.props", """
                <Project>
                  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
                  <ItemGroup>
                    <PackageVersion Include="Serilog" Version="4.0.0" />
                    <PackageVersion Include="Polly" Version="8.0.0" />
                  </ItemGroup>
                </Project>
                """)
            .Project("App", extra: "</PropertyGroup><ItemGroup><PackageReference Include=\"Serilog\" /><PackageReference Include=\"Polly\" VersionOverride=\"8.4.0\" /></ItemGroup><PropertyGroup>");

        var app = ProjectLoader.ReadProject(Path.Combine(ws.Root, "App", "App.csproj"));
        Assert.Equal(new[] { ("Serilog", "4.0.0"), ("Polly", "8.4.0") }, app.PackageReferences.Select(p => (p.Name, p.Version ?? "")));
    }

    [Fact]
    public void A_blazor_webassembly_project_is_an_application()
    {
        using var ws = new TestWorkspace().Project("Admin", sdk: "Microsoft.NET.Sdk.BlazorWebAssembly");
        Assert.Equal("Exe", ProjectLoader.ReadProject(Path.Combine(ws.Root, "Admin", "Admin.csproj")).OutputType);
    }

    [Fact]
    public void The_framework_of_the_project_version_is_preferred_runtime_then_reference_pack()
    {
        using var ws = new TestWorkspace()
            .File("dotnet/shared/Microsoft.NETCore.App/8.0.5/System.Runtime.dll", "")
            .File("dotnet/shared/Microsoft.NETCore.App/8.0.10/System.Runtime.dll", "")
            .File("dotnet/packs/Microsoft.NETCore.App.Ref/10.0.2/ref/net10.0/System.Runtime.dll", "")
            .File("dotnet/packs/Microsoft.NETCore.App.Ref/9.0.1/data/FrameworkList.xml", ""); // no ref/net9.0: not usable
        var roots = new[] { Path.Combine(ws.Root, "dotnet") };
        string? Find(int major) => FrameworkLocator.FindFramework("Microsoft.NETCore.App", major, roots) is { } dir ? Path.GetRelativePath(ws.Root, dir).Replace('\\', '/') : null;

        Assert.Equal("dotnet/shared/Microsoft.NETCore.App/8.0.10", Find(8));              // the newest runtime of that major version
        Assert.Equal("dotnet/packs/Microsoft.NETCore.App.Ref/10.0.2/ref/net10.0", Find(10)); // no runtime: its reference pack
        Assert.Equal("dotnet/packs/Microsoft.NETCore.App.Ref/10.0.2/ref/net10.0", Find(9));  // none: the next one above
        Assert.Null(Find(11));
        Assert.Equal(10, CompilationFactory.NetMajor("net10.0"));
        Assert.Equal(8, CompilationFactory.NetMajor("net8.0-windows"));
        Assert.Null(CompilationFactory.NetMajor("netstandard2.0"));
        Assert.Null(CompilationFactory.NetMajor("net472"));
    }

    [Fact]
    public void A_net10_project_sees_the_net10_api_when_it_is_installed()
    {
        if (FrameworkLocator.FindFramework("Microsoft.NETCore.App", 10) is not { } net10 || !File.Exists(Path.Combine(net10, "System.Threading.dll"))) return; // no .NET 10 here
        using var ws = new TestWorkspace()
            .File("App/App.csproj", """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>""")
            .File("App/C.cs", "namespace App;\npublic class C { public void Run(System.Threading.Lock gate) { } }\n");

        var graph = ws.Analyze();
        Assert.Contains(graph.Nodes, n => n.Id == "M:App.C.Run(System.Threading.Lock)"); // System.Threading.Lock is new in .NET 9
    }

    [Fact]
    public void Unrestored_microsoft_extensions_packages_are_backed_by_the_shared_framework()
    {
        using var ws = new TestWorkspace()
            .Project("Lib", extra: "</PropertyGroup><ItemGroup><PackageReference Include=\"Microsoft.Extensions.DependencyInjection.Abstractions\" Version=\"8.0.0\" /></ItemGroup><PropertyGroup>")
            .File("Lib/Setup.cs", """
                using Microsoft.Extensions.DependencyInjection;
                namespace Lib;
                public interface IFoo { }
                public class Foo : IFoo { }
                public static class Setup
                {
                    public static IServiceCollection AddLib(this IServiceCollection services) => services.AddSingleton<IFoo, Foo>();
                }
                """);

        var graph = ws.Analyze();
        Assert.Contains(graph.Nodes, n => n.Id == "M:Lib.Setup.AddLib(Microsoft.Extensions.DependencyInjection.IServiceCollection)");
        Assert.Contains(graph.Analysis.Di!.Registrations, r => r is { Service: "T:Lib.IFoo", Implementation: "T:Lib.Foo" });
    }
}
