using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Languages.CSharp;
using CodeMap.Languages.External;
using CodeMap.Loading;
using CodeMap.Server;
using Xunit;

namespace CodeMap.Tests;

/// <summary>
/// What a language with project files named after the project (C/C++: Game.vcxproj, Game.Build.cs) needs from the
/// core: such markers, Unreal's C# build scripts not taken for C# code, and Visual Studio C++ solutions.
/// </summary>
public class NativeProjectTests
{
    private const string CppSolution = """
        Microsoft Visual Studio Solution File, Format Version 12.00
        Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Game", "Game\Game.vcxproj", "{11111111-1111-1111-1111-111111111111}"
        EndProject
        """;

    private const string MixedSolution = """
        Microsoft Visual Studio Solution File, Format Version 12.00
        Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Tools", "Tools\Tools.csproj", "{22222222-2222-2222-2222-222222222222}"
        EndProject
        Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Engine", "Engine\Engine.vcxproj", "{11111111-1111-1111-1111-111111111111}"
        EndProject
        """;

    [Fact]
    public void Markers_with_a_wildcard_find_project_files_named_after_the_project()
    {
        using var ws = new TestWorkspace()
            .File("Game/Game.vcxproj", "<Project />")
            .File("Game/src/main.cpp", "int main() { return 0; }")
            .File("docs/readme.md", "");
        var cpp = Native(ws);

        Assert.True(cpp.Detect(ws.Root, CancellationToken.None));
        Assert.True(cpp.Detect(Path.Combine(ws.Root, "Game", "src"), CancellationToken.None)); // the project file is above
        Assert.False(cpp.Detect(Path.Combine(ws.Root, "docs"), CancellationToken.None));
        Assert.Equal(new[] { "Game.vcxproj" }, cpp.MarkersIn(Path.Combine(ws.Root, "Game")).Select(m => Path.GetFileName(m.File)));
        Assert.True(cpp.IsWatched(Path.Combine(ws.Root, "Game", "Game.vcxproj")));
        Assert.True(cpp.IsWatched(Path.Combine(ws.Root, "Shop.Build.cs")));
        Assert.False(cpp.IsWatched(Path.Combine(ws.Root, "Shop.cs")));
    }

    [Fact]
    public void Unreal_build_scripts_are_not_a_csharp_project()
    {
        using var ws = new TestWorkspace()
            .File("Shop.uproject", "{}")
            .File("Source/Shop.Target.cs", "public class ShopTarget : TargetRules { }")
            .File("Source/Shop/Shop.Build.cs", "public class Shop : ModuleRules { }")
            .File("Source/Shop/ShopActor.cpp", "void f() {}");
        var csharp = new CSharpAnalyzer();

        Assert.False(csharp.Detect(ws.Root, CancellationToken.None));
        Assert.True(Native(ws).Detect(ws.Root, CancellationToken.None));

        // Real C# beside them is still C#, without the build scripts.
        ws.File("Tools/Report.cs", "class Report { }");
        Assert.True(csharp.Detect(ws.Root, CancellationToken.None));
        var load = ProjectLoader.Load(ws.Root);
        Assert.Equal(new[] { "Report.cs" }, load.Projects.Single().SourceFiles.Select(Path.GetFileName));
    }

    [Fact]
    public void Build_scripts_outside_an_unreal_project_are_ordinary_csharp()
    {
        using var ws = new TestWorkspace().File("Build/Release.Build.cs", "class Release { }");

        Assert.True(new CSharpAnalyzer().Detect(ws.Root, CancellationToken.None));
    }

    [Fact]
    public void A_solution_without_csharp_projects_is_left_to_its_own_language()
    {
        using var ws = new TestWorkspace()
            .File("Game.sln", CppSolution)
            .File("Game.slnx", """<Solution><Project Path="Game/Game.vcxproj" /></Solution>""")
            .File("Mixed.sln", MixedSolution)
            .File("Game/Game.vcxproj", "<Project />")
            .File("Game/main.cpp", "int main() { return 0; }");
        var csharp = new CSharpAnalyzer();

        Assert.False(csharp.CanAnalyzeFile(Path.Combine(ws.Root, "Game.sln")));
        Assert.False(csharp.CanAnalyzeFile(Path.Combine(ws.Root, "Game.slnx")));
        Assert.True(csharp.CanAnalyzeFile(Path.Combine(ws.Root, "Mixed.sln")));
        Assert.Equal(new[] { "Mixed.sln" }, csharp.MarkersIn(ws.Root).Select(m => Path.GetFileName(m.File)));
        ws.File("New.sln", "Microsoft Visual Studio Solution File, Format Version 12.00");
        Assert.True(csharp.CanAnalyzeFile(Path.Combine(ws.Root, "New.sln"))); // no project yet: still C#, as before

        // Nothing reads it: the message says why, not "use a .sln".
        var registry = new LanguageRegistry(new ILanguageAnalyzer[] { csharp });
        var error = Assert.Throws<ArgumentException>(() => CodeMapAnalyzer.Analyze(Path.Combine(ws.Root, "Game.sln"), registry, new AnalyzerOptions { Git = false }));
        Assert.Contains("lists no project CodeMap can read", error.Message);

        // A language that reads solutions gets it.
        var withNative = new LanguageRegistry(new ILanguageAnalyzer[] { csharp, Native(ws) });
        Assert.Same(withNative.Languages[1], withNative.Languages.First(l => l.CanAnalyzeFile(Path.Combine(ws.Root, "Game.sln"))));
    }

    [Fact]
    public void A_mixed_solution_maps_its_csharp_and_says_what_it_left_out()
    {
        using var ws = new TestWorkspace()
            .File("Mixed.sln", MixedSolution)
            .Project("Tools")
            .File("Tools/Report.cs", "namespace Tools; public class Report { }")
            .File("Engine/Engine.vcxproj", "<Project />");

        var load = ProjectLoader.Load(Path.Combine(ws.Root, "Mixed.sln"));

        Assert.Equal("Tools", load.Projects.Single().Name);
        Assert.Contains(load.Warnings, w => w.Contains("1 C/C++ project(s) (Engine.vcxproj)") && w.Contains("Analyze the solution's folder"));
    }

    [Fact]
    public void The_browser_does_not_pick_a_solution_nothing_reads()
    {
        using var ws = new TestWorkspace()
            .File("Game.sln", CppSolution)
            .File("Game/Game.vcxproj", "<Project />")
            .File("Game/main.cpp", "int main() { return 0; }");
        var csharpOnly = new LanguageRegistry(new ILanguageAnalyzer[] { new CSharpAnalyzer() });

        Assert.Equal(ws.Root, DirectoryBrowser.ResolveAnalysisTarget(ws.Root, csharpOnly));
        Assert.Equal(ws.Root, DirectoryBrowser.ResolveAnalysisTarget(ws.Root, new LanguageRegistry(new ILanguageAnalyzer[] { new CSharpAnalyzer(), Native(ws) })));
    }

    /// <summary>A C/C++-like language from a manifest alone (no runtime needed to detect files).</summary>
    private static ExternalProcessAnalyzer Native(TestWorkspace ws)
    {
        var folder = Path.Combine(ws.Root, "..", "manifest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, PluginManifest.FileName);
        File.WriteAllText(path, """
            { "protocol": 1, "id": "native", "idPrefix": "native:", "name": "Native", "command": ["native"],
              "detect": {
                "markers": ["CMakeLists.txt", "*.vcxproj", "*.uproject", "*.Build.cs"],
                "sources": [".c", ".cpp"], "inputs": ["*.sln", "*.vcxproj", "*.cpp", "*.h"]
              } }
            """);
        try
        {
            return new ExternalProcessAnalyzer(PluginManifest.Load(path));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
