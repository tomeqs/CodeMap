using System.Xml.Linq;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Loading;
using CodeMap.Model;

namespace CodeMap.Tests;

public class LoaderTests
{
    private static string[] Sources(TestWorkspace ws, string project) =>
        ProjectLoader.ReadProject(Path.Combine(ws.Root, project)).SourceFiles
            .Select(f => Path.GetRelativePath(ws.Root, f).Replace('\\', '/')).Order(StringComparer.Ordinal).ToArray();

    [Fact]
    public void Compile_items_follow_their_conditions_for_the_target_framework()
    {
        using var ws = new TestWorkspace()
            .File("Lib/Lib.csproj", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFrameworks>net8.0;netstandard2.0</TargetFrameworks></PropertyGroup>
                  <ItemGroup Condition="'$(TargetFramework)' == 'netstandard2.0'"><Compile Remove="Modern/**" /></ItemGroup>
                  <ItemGroup Condition=" '$(TargetFramework)' != 'netstandard2.0' "><Compile Remove="Legacy/**" /></ItemGroup>
                  <ItemGroup><Compile Remove="Generated/**" Condition="'$(Configuration)' == 'Debug' and '$(TargetFramework)' == 'net8.0'" /></ItemGroup>
                </Project>
                """)
            .File("Lib/Core.cs", "class Core { }")
            .File("Lib/Modern/A.cs", "class A { }")
            .File("Lib/Legacy/B.cs", "class B { }")
            .File("Lib/Generated/G.cs", "class G { }");

        // net8.0 is the framework we compile for: its removals apply, the netstandard2.0 ones don't.
        Assert.Equal(new[] { "Lib/Core.cs", "Lib/Modern/A.cs" }, Sources(ws, "Lib/Lib.csproj"));
    }

    [Fact]
    public void A_compile_include_after_a_remove_brings_the_file_back()
    {
        using var ws = new TestWorkspace()
            .File("Lib/Lib.csproj", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
                  <ItemGroup>
                    <Compile Remove="Legacy/**" />
                    <Compile Include="Legacy/Shim.cs" />
                    <Compile Include="../Shared/**/*.cs" Exclude="../Shared/Old/**" />
                  </ItemGroup>
                </Project>
                """)
            .File("Lib/Core.cs", "class Core { }")
            .File("Lib/Legacy/Old.cs", "class Old { }")
            .File("Lib/Legacy/Shim.cs", "class Shim { }")
            .File("Shared/Util.cs", "class Util { }")
            .File("Shared/Old/Gone.cs", "class Gone { }");

        Assert.Equal(new[] { "Lib/Core.cs", "Lib/Legacy/Shim.cs", "Shared/Util.cs" }, Sources(ws, "Lib/Lib.csproj"));
    }

    [Theory]
    [InlineData("EnableDefaultItems")]
    [InlineData("EnableDefaultCompileItems")]
    public void Without_default_items_only_the_listed_files_are_compiled(string property)
    {
        using var ws = new TestWorkspace()
            .File("Lib/Lib.csproj", $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>net8.0</TargetFramework><{property}>false</{property}></PropertyGroup>
                  <ItemGroup><Compile Include="Src/A.cs" /></ItemGroup>
                </Project>
                """)
            .File("Lib/Src/A.cs", "class A { }")
            .File("Lib/Src/Other.cs", "class Other { }");

        Assert.Equal(new[] { "Lib/Src/A.cs" }, Sources(ws, "Lib/Lib.csproj"));
    }

    [Fact]
    public void An_unreadable_folder_in_a_project_is_skipped_not_the_project()
    {
        // root reads everything and Windows has no Unix modes: nothing to check there.
        if (OperatingSystem.IsWindows() || Environment.UserName == "root") return;
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Code.cs", "namespace App; public class Kept { }")
            .File("App/data/postgres/readme.txt", "");
        var locked = Path.Combine(ws.Root, "App", "data", "postgres");
        File.SetUnixFileMode(locked, UnixFileMode.None);
        try
        {
            Assert.Equal(new[] { "App/Code.cs" }, Sources(ws, "App/App.csproj"));
        }
        finally
        {
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Theory]
    [InlineData("'$(TargetFramework)' == 'net8.0'", true)]
    [InlineData("'$(TargetFramework)'=='NET8.0'", true)]
    [InlineData("'$(TargetFramework)' != 'net8.0'", false)]
    [InlineData("'$(Configuration)|$(Platform)' == 'Debug|AnyCPU'", true)]
    [InlineData("$(TargetFramework) == 'net8.0' and ('$(Missing)' == '' or false)", true)]
    [InlineData("!('$(Configuration)' == 'Release')", true)]
    [InlineData("Exists('foo.props')", null)]
    [InlineData("'$(TargetFramework.StartsWith(net))' == 'true'", null)]
    [InlineData("'@(Compile)' != ''", null)]
    [InlineData("", true)]
    public void Simple_msbuild_conditions_are_evaluated(string condition, bool? expected)
    {
        var properties = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["TargetFramework"] = "net8.0", ["Configuration"] = "Debug", ["Platform"] = "AnyCPU" };
        Assert.Equal(expected, MsBuildCondition.Evaluate(condition, key => properties.GetValueOrDefault(key)));
    }

    [Fact]
    public void Reads_solution_and_respects_compile_removals_and_nested_projects()
    {
        using var ws = new TestWorkspace()
            .File("My.sln", """
                Microsoft Visual Studio Solution File, Format Version 12.00
                Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Lib", "src\Lib\Lib.csproj", "{A}"
                EndProject
                Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Folder", "Folder", "{B}"
                EndProject
                """)
            .File("src/Lib/Lib.csproj", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><AssemblyName>My.Lib</AssemblyName><DefineConstants>FEATURE_X</DefineConstants></PropertyGroup>
                  <ItemGroup><Compile Remove="Legacy/**" /></ItemGroup>
                  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>
                </Project>
                """)
            .File("src/Lib/A.cs", "namespace Lib; public class A { }")
            .File("src/Lib/Legacy/Old.cs", "namespace Lib; public class Old { }")
            .File("src/Lib/obj/Debug/Gen.cs", "namespace Lib; public class Gen { }")
            .File("src/Lib/Nested/Nested.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
            .File("src/Lib/Nested/N.cs", "namespace Nested; public class N { }");

        var load = ProjectLoader.Load(Path.Combine(ws.Root, "My.sln"));

        var project = Assert.Single(load.Projects);
        Assert.Equal("solution", load.Kind);
        Assert.Equal("Lib", project.Name);
        Assert.Equal("My.Lib", project.AssemblyName);
        Assert.Contains("FEATURE_X", project.DefineConstants);
        Assert.Equal("Newtonsoft.Json", Assert.Single(project.PackageReferences).Name);
        Assert.Equal(new[] { "A.cs" }, project.SourceFiles.Select(Path.GetFileName));
    }

    [Fact]
    public void Reads_slnx_and_solution_filters()
    {
        using var ws = new TestWorkspace()
            .Project("A")
            .Project("B")
            .File("A/A.cs", "namespace A; public class X { }")
            .File("B/B.cs", "namespace B; public class Y { }")
            .File("All.slnx", """
                <Solution>
                  <Folder Name="/src/">
                    <Project Path="A/A.csproj" />
                    <Project Path="B/B.csproj" />
                  </Folder>
                </Solution>
                """)
            .File("OnlyB.slnf", """
                { "solution": { "path": "All.slnx", "projects": [ "B\\B.csproj" ] } }
                """);

        Assert.Equal(new[] { "A", "B" }, ProjectLoader.Load(Path.Combine(ws.Root, "All.slnx")).Projects.Select(p => p.Name).Order());
        Assert.Equal("B", Assert.Single(ProjectLoader.Load(Path.Combine(ws.Root, "OnlyB.slnf")).Projects).Name);
    }

    [Fact]
    public void Folder_without_projects_becomes_a_virtual_project()
    {
        using var ws = new TestWorkspace()
            .File("one.cs", "namespace X; public class One { public Two Make() => new(); }")
            .File("sub/two.cs", "namespace X; public class Two { }");

        var graph = ws.Analyze();

        Assert.Single(graph.Nodes, n => n.Kind == NodeKinds.Project);
        graph.AssertEdge("M:X.One.Make", EdgeKinds.Instantiates, "T:X.Two");
    }

    [Fact]
    public void Cycle_detector_finds_strongly_connected_components()
    {
        var graph = new Dictionary<string, HashSet<string>>
        {
            ["a"] = new() { "b" },
            ["b"] = new() { "c" },
            ["c"] = new() { "a", "d" },
            ["d"] = new() { "e" },
            ["e"] = new() { "d" },
            ["f"] = new() { "a" },
        };

        var cycles = CycleDetector.FindCycles(graph);

        Assert.Equal(2, cycles.Count);
        Assert.Contains(cycles, c => c.SequenceEqual(new[] { "a", "b", "c" }));
        Assert.Contains(cycles, c => c.SequenceEqual(new[] { "d", "e" }));
    }
}

public class ExportTests
{
    private static CodeGraph Sample()
    {
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Code.cs", """
                namespace App;
                /// <summary>Talks to <see cref="Repo"/> &amp; friends.</summary>
                public class Service { private readonly Repo _repo = new(); public int Count() => _repo.All().Count; }
                public class Repo { public List<string> All() => new() { "</script>" }; }
                """);
        return ws.Analyze();
    }

    [Fact]
    public void Json_round_trips()
    {
        var graph = Sample();
        var json = JsonExporter.Serialize(graph);
        using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json));
        var back = JsonExporter.Read(stream);

        Assert.Equal("codemap", back.Format);
        Assert.Equal(graph.Nodes.Count, back.Nodes.Count);
        Assert.Equal(graph.Edges.Count, back.Edges.Count);
        Assert.Equal("Talks to Repo & friends.", back.Nodes.Single(n => n.Id == "T:App.Service").Doc);
        Assert.Contains("\"kind\":\"calls\"", json);
    }

    [Fact]
    public void Collapsing_members_lifts_edges_to_types()
    {
        var graph = Sample();

        GraphView.CollapseMembers(graph);

        Assert.DoesNotContain(graph.Nodes, n => NodeKinds.IsMember(n.Kind));
        graph.AssertEdge("T:App.Service", EdgeKinds.Calls, "T:App.Repo");
        graph.AssertEdge("T:App.Service", EdgeKinds.Holds, "T:App.Repo");
        Assert.All(graph.Edges, e => Assert.Contains(graph.Nodes, n => n.Id == e.Source));
    }

    [Fact]
    public void Xml_exports_are_well_formed()
    {
        var graph = Sample();

        var dgml = XDocument.Parse(DgmlExporter.Export(graph).ToString());
        Assert.Equal("DirectedGraph", dgml.Root!.Name.LocalName);
        Assert.Contains(dgml.Descendants().Where(e => e.Name.LocalName == "Link"),
            l => (string?)l.Attribute("Source") == "T:App.Service" && (string?)l.Attribute("Target") == "T:App.Repo");

        var graphml = XDocument.Parse(GraphMLExporter.Export(graph).ToString());
        var edgeCount = graphml.Descendants().Count(e => e.Name.LocalName == "edge");
        Assert.Equal(graph.Edges.Count + graph.Nodes.Count(n => n.Parent != null), edgeCount);
    }

    [Fact]
    public void Cypher_and_markdown_contain_the_graph()
    {
        var graph = Sample();

        var cypher = CypherExporter.Export(graph);
        Assert.Contains("CREATE (n:Code:Class)", cypher);
        Assert.Contains("[:CALLS {weight: row.w}]", cypher);
        Assert.Contains("[:CONTAINS {weight: row.w}]", cypher);
        Assert.Contains("'T:App.Service'", cypher);

        var markdown = MarkdownReport.Export(graph);
        Assert.Contains("# CodeMap:", markdown);
        Assert.Contains("| App |", markdown);
    }

    [Fact]
    public void Html_embeds_escaped_json()
    {
        var graph = Sample();
        var template = "<html><head><title>CodeMap</title></head><body>" + HtmlExporter.Placeholder + "<script>boot()</script></body></html>";

        var html = HtmlExporter.Export(graph, template);

        Assert.DoesNotContain(HtmlExporter.Placeholder, html);
        Assert.Contains("<title>CodeMap · ", html);
        var start = html.IndexOf("application/json\">", StringComparison.Ordinal) + "application/json\">".Length;
        var end = html.IndexOf("</script>", start, StringComparison.Ordinal);
        var json = html[start..end];
        Assert.DoesNotContain("</", json);
        Assert.Contains("T:App.Service", json);
    }

    [Fact]
    public void Html_data_holds_no_markup_that_a_browser_reads_inside_a_script()
    {
        // As in a real map: a doc comment with "<!--<script" makes the browser take the rest of the page for the data.
        using var ws = new TestWorkspace()
            .Project("App")
            .File("App/Code.cs", """
                namespace App;
                /// <summary>Renders &lt;!--&lt;script&gt; tags and &lt;/script&gt; too.</summary>
                public class Page { }
                """);
        var graph = ws.Analyze();

        var html = HtmlExporter.Export(graph, "<html><head><title>CodeMap</title></head><body>" + HtmlExporter.Placeholder + "<script>boot()</script></body></html>");

        var start = html.IndexOf("application/json\">", StringComparison.Ordinal) + "application/json\">".Length;
        var json = html[start..html.IndexOf("</script>", start, StringComparison.Ordinal)];
        Assert.DoesNotContain("<", json);
        using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json));
        Assert.Contains("<!--<script>", JsonExporter.Read(stream).Node("T:App.Page").Doc); // the same text once parsed
        Assert.EndsWith("<script>boot()</script></body></html>", html);
    }
}
