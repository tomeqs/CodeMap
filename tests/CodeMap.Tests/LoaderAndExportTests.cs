using System.Xml.Linq;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Loading;
using CodeMap.Model;

namespace CodeMap.Tests;

public class LoaderTests
{
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
}
