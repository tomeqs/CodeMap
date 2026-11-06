using System.Text;
using CodeMap.Export;
using CodeMap.Insights;

namespace CodeMap.Tests;

/// <summary>
/// The C# call flow (CodeMap.Insights.CallFlow) gives what the viewer's Flow view shows: the entry points, the flows
/// and their sequence diagrams of the golden maps, as viewer/src/data/flow.js computes them
/// (Golden/*.flows.txt, made by Golden/flows.mjs; regenerate them after a change to flow.js).
/// </summary>
public class CallFlowTests
{
    [Theory]
    [InlineData("shop")]
    [InlineData("booking")]
    public void Flows_match_what_the_viewer_computes(string name)
    {
        var golden = Path.Combine(GoldenTests.RepoRoot(), "tests", "CodeMap.Tests", "Golden");
        var json = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Path.Combine(golden, name + ".codemap.json")))!;
        json["generatedAt"] = "2026-01-01T00:00:00Z"; // the golden files hold "(time)"
        var graph = System.Text.Json.JsonSerializer.Deserialize<CodeMap.Model.CodeGraph>(json.ToJsonString(), JsonExporter.Options)!;
        var flows = new CallFlow(new GraphIndex(graph));

        var sb = new StringBuilder();
        foreach (var entry in flows.FindEntryPoints())
        {
            sb.Append($"## {entry.Node.Id} ({entry.Role}, reach {entry.Reach}): {string.Join(", ", entry.Methods.Select(m => m.Id))}\n");
            var flow = flows.Build(new[] { entry.Node.Id });
            sb.Append($"methods {flow.Methods.Count}, types {flow.Types}, depth {flow.Depth}, truncated {(flow.Truncated ? "true" : "false")}\n");
            foreach (var root in flow.Tree) sb.Append(flows.ToMermaid(root)).Append('\n');
        }

        var expected = File.ReadAllText(Path.Combine(golden, name + ".flows.txt")).ReplaceLineEndings("\n");
        Assert.Equal(expected, sb.ToString());
    }
}
