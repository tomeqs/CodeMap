using System.Text.Json;
using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Languages.External;
using CodeMap.Server;
using Xunit;

namespace CodeMap.Tests;

/// <summary>
/// Projects that are folders (Xcode's App.xcodeproj; the stub plugin's App.stubproj, see its manifest's
/// detect.bundles): taken as input like a project file, rooted at the folder they are in, and marking that folder
/// like a project file would.
/// </summary>
public class BundleProjectTests
{
    private static string StubFolder => Path.Combine(GoldenTests.RepoRoot(), "tests", "CodeMap.Tests", "Plugins", "stub");

    private static (LanguageRegistry Registry, ExternalProcessAnalyzer Stub) Stub()
    {
        var registry = LanguageRegistry.WithPlugins(new[] { StubFolder });
        return (registry, (ExternalProcessAnalyzer)registry.Find("stub")!);
    }

    [NodeFact]
    public void A_project_folder_is_analyzed_like_a_project_file_rooted_at_its_folder()
    {
        using var ws = new TestWorkspace()
            .File("App/App.stubproj/project.stubindex", "")
            .File("App/a.stub", "")
            .File("App/src/b.stub", "")
            .File("App/Tool.cs", "class Tool { }"); // C# beside it: a folder's map would have it, the project's does not
        var app = Path.Combine(ws.Root, "App");
        var bundle = Path.Combine(app, "App.stubproj");

        // With a trailing separator too, as a shell completes a folder's name.
        var graph = CodeMapAnalyzer.Analyze(bundle + Path.DirectorySeparatorChar, Stub().Registry, new AnalyzerOptions { Git = false });

        var request = JsonDocument.Parse(graph.Node("stub:project").Doc!).RootElement;
        Assert.Equal(bundle, request.GetProperty("target").GetString());
        Assert.Equal(app, request.GetProperty("root").GetString());
        Assert.Equal(app, graph.Source.Root);
        Assert.Equal("src/b.stub", graph.Node("stub:b.stub").Location!.File);
        Assert.Equal("stub", Assert.Single(graph.Source.Languages!).Id);
    }

    [NodeFact]
    public void A_folder_named_like_a_project_without_its_file_is_an_ordinary_folder()
    {
        using var ws = new TestWorkspace().File("Old.stubproj/stub.json", "{}").File("Old.stubproj/c.stub", "");
        var folder = Path.Combine(ws.Root, "Old.stubproj");
        var (registry, stub) = Stub();

        Assert.False(stub.IsBundle(folder));
        Assert.Null(registry.BundleOwner(folder));
        Assert.Equal(folder, registry.RootOf(folder));

        var graph = CodeMapAnalyzer.Analyze(folder, registry, new AnalyzerOptions { Git = false });
        var request = JsonDocument.Parse(graph.Node("stub:project").Doc!).RootElement;
        Assert.Equal(folder, request.GetProperty("root").GetString());
        Assert.Equal("c.stub", graph.Node("stub:c.stub").Location!.File);
    }

    [Fact]
    public void A_project_folder_marks_its_folder_and_is_listed_watched_and_browsed_as_a_project()
    {
        using var ws = new TestWorkspace()
            .File("App/App.stubproj/project.stubindex", "")
            .File("App/Sources/a.stub", "")
            .File("Lib/Empty.stubproj/readme.txt", "")
            .File("Lib/b.stub", "")
            .File("Pkg/Pkg.stubproj/project.stubindex", "")
            .File("Pkg/Pkg.stubproj/inside.stub", "");
        var (registry, stub) = Stub();
        var app = Path.Combine(ws.Root, "App");
        var bundle = Path.Combine(app, "App.stubproj");
        var ct = CancellationToken.None;

        // Detection: the project folder is the folder's project file; it is not code itself.
        Assert.True(stub.IsBundle(bundle));
        Assert.True(stub.IsBundle(bundle + Path.DirectorySeparatorChar));
        Assert.False(stub.IsBundle(Path.Combine(ws.Root, "Lib", "Empty.stubproj")));
        Assert.True(stub.Detect(app, ct));
        Assert.True(stub.Detect(Path.Combine(app, "Sources"), ct)); // the project folder is above it
        Assert.False(stub.Detect(Path.Combine(ws.Root, "Lib"), ct)); // named like one, without its file
        Assert.False(stub.Detect(Path.Combine(ws.Root, "Pkg"), ct)); // what is inside a project folder is not code
        Assert.Same(stub, registry.BundleOwner(bundle));
        Assert.Equal(app, registry.RootOf(bundle));

        // The folder browser: a project, in the folder and in the listing of the folder above.
        Assert.Equal(new[] { "App.stubproj" }, stub.MarkersIn(app).Select(m => Path.GetFileName(m.File)));
        var listing = DirectoryBrowser.Browse(app, ws.Root, registry);
        var entry = Assert.Single(listing.Entries, e => e.Name == "App.stubproj");
        Assert.Equal(("project", "stub"), (entry.Kind, entry.Languages!.Single()));
        Assert.Contains("stub", DirectoryBrowser.Browse(ws.Root, ws.Root, registry).Entries.Single(e => e.Name == "App").Languages!);
        Assert.Equal(app, DirectoryBrowser.Browse(bundle, ws.Root, registry).Path); // like a project file: its folder
        Assert.Contains("*.stubproj", stub.Info.InputPatterns); // the app's path box analyzes it rather than opening it

        // Live updates: its file, and a project folder created, renamed or moved in; not the rest of what it holds.
        Assert.True(SourceChangeFilter.IsRelevant(Path.Combine(bundle, "project.stubindex"), registry, ws.Root));
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(app, "Other", "project.stubindex"), registry, ws.Root));
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(bundle, "xcuserdata", "state.bin"), registry, ws.Root));
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(app, "Notes.stubproj"), registry, ws.Root)); // no project in it
        ws.File("App/New.stubproj/project.stubindex", "");
        Assert.True(SourceChangeFilter.IsRelevant(Path.Combine(app, "New.stubproj"), registry, ws.Root));

        // Xcode keeps a project.xcworkspace in every App.xcodeproj: a project folder inside one is not another project.
        ws.File("App/App.stubproj/inner.stubproj/project.stubindex", "");
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(bundle, "inner.stubproj", "project.stubindex"), registry, ws.Root));
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(bundle, "inner.stubproj"), registry, ws.Root));
    }

    [Fact]
    public void Project_folder_names_are_compared_without_case_and_entries_without_spaces_around_them()
    {
        using var ws = new TestWorkspace()
            .File("App/APP.STUBPROJ/Project.StubIndex", "")
            .File("App/a.stub", "")
            .File("spaced/codemap-plugin.json", Manifest(" *.xcodeproj / project.pbxproj "))
            .File("App/App.xcodeproj/project.pbxproj", "");
        var (_, stub) = Stub();

        var bundle = Path.Combine(ws.Root, "App", "APP.STUBPROJ");
        Assert.True(stub.IsBundle(bundle));
        Assert.True(stub.IsWatched(Path.Combine(bundle, "Project.StubIndex")));
        Assert.True(stub.Detect(Path.Combine(ws.Root, "App"), CancellationToken.None));

        var spaced = new ExternalProcessAnalyzer(PluginManifest.Load(Path.Combine(ws.Root, "spaced", PluginManifest.FileName)));
        Assert.True(spaced.IsBundle(Path.Combine(ws.Root, "App", "App.xcodeproj")));
        Assert.Equal(new[] { "*.x", "*.xcodeproj" }, spaced.Info.InputPatterns);
        Assert.Equal("*.x, *.xcodeproj file", spaced.Info.Inputs); // the messages name it too
    }

    [Theory]
    [InlineData("*.stubproj")]
    [InlineData("*.stubproj/")]
    [InlineData("/project.stubindex")]
    [InlineData("a/b/c")]
    [InlineData("*.stubproj/*.index")]
    [InlineData("*.stubproj/project.?")]
    [InlineData("../project.stubindex")]
    [InlineData("*.stubproj\\project.stubindex")]
    public void Bundle_entries_name_a_folder_and_a_file_in_it(string bundle)
    {
        using var ws = new TestWorkspace()
            .File("bad/codemap-plugin.json", Manifest(bundle))
            .File("good/codemap-plugin.json", Manifest("*.xcodeproj/project.pbxproj"));

        var error = Assert.Throws<InvalidDataException>(() => PluginManifest.Load(Path.Combine(ws.Root, "bad", PluginManifest.FileName)));
        Assert.Contains("detect.bundles entry", error.Message);
        Assert.Equal(new[] { "*.x", "*.xcodeproj" }, PluginManifest.Load(Path.Combine(ws.Root, "good", PluginManifest.FileName)).ToLanguageInfo().InputPatterns);
    }

    private static string Manifest(string bundle) => $$"""
        { "protocol": 1, "id": "xx", "idPrefix": "xx:", "name": "xx", "command": ["node", "./x.mjs"],
          "detect": { "markers": ["x.json"], "sources": [".x"], "inputs": ["*.x"], "bundles": [{{JsonSerializer.Serialize(bundle)}}] } }
        """;
}
