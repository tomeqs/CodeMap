using CodeMap.Insights;
using CodeMap.Mcp.Rendering;
using CodeMap.Model;

namespace CodeMap.Mcp;

/// <summary>An answer with a picture: the PNG and what it shows.</summary>
internal sealed record ImageAnswer(byte[] Png, object Caption);

internal static partial class Tools
{
    private static readonly string[] Views = { "galaxy", "city", "layers", "di", "flow", "matrix" };

    private static readonly ToolDef RenderMap = new("render_map", "Picture of the 3D map",
        "A PNG of CodeMap's 3D map (rendered in a headless Chrome, Edge or Chromium), with a caption of what it shows. Views: " +
        "galaxy (dependencies as a force graph), city (types as buildings: height = complexity), layers (computed layers, upward " +
        "dependencies in red), di (the container's wiring and lifetimes), flow (a call flow), matrix (a dependency structure " +
        "matrix). Show a level, select a node with its neighbours or what depends on it, a path between two nodes, a cycle, a DI " +
        "issue, a flow, or highlight any nodes. Without a browser, use diagram (Mermaid) instead.",
        """
        {"type":"object","properties":{
          "view":{"type":"string","enum":["galaxy","city","layers","di","flow","matrix"],"description":"Default galaxy (layers for upward dependencies)."},
          "level":{"type":"string","enum":["project","namespace","type","member","auto"],"description":"Default: types, or namespaces for a big map."},
          "focus":{"type":"string","description":"A node to select and center (id or name)."},
          "mode":{"type":"string","enum":["neighbors","dependencies","dependents"],"description":"What lights up around the focus (default neighbors)."},
          "path":{"type":"array","items":{"type":"string"},"description":"[from, to]: the dependency path between two nodes."},
          "cycle":{"type":"string","description":"A cycle finding id, or a node in a cycle."},
          "diIssue":{"type":"string","description":"A DI finding id, or the consumer of a DI issue."},
          "flowRoots":{"type":"array","items":{"type":"string"},"description":"Methods or types to show the call flow of (the flow view)."},
          "highlight":{"type":"array","items":{"type":"string"},"description":"Nodes to light up (e.g. the nodes of a finding)."},
          "width":{"type":"number","description":"Pixels (default 1280)."},
          "height":{"type":"number","description":"Pixels (default 800)."},
          "graph":{"type":"string","description":"current (default), previous, a baseline, a simulation (sim-N) or a .codemap.json path."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var index = s.Index;
            string Id(string field) => call.Node(s, call.Required(field)).Id;
            var types = s.Graph.Stats.GetValueOrDefault("types");
            var level = call.String("level") is { } l ? call.Choice("level", l, "project", "namespace", "type", "member", "auto") : null;
            var view = call.Choice("view", "galaxy", Views);

            CycleInfo? cycle = null;
            if (call.String("cycle") is { } cycleRef)
            {
                var finding = s.Findings.Findings.FirstOrDefault(f => f.Id == cycleRef);
                var nodes = finding?.Nodes ?? new List<string> { Id("cycle") };
                cycle = s.Graph.Analysis.Cycles.Where(c => nodes.Any(c.Nodes.Contains)).OrderByDescending(c => c.Nodes.Count(nodes.Contains)).ThenBy(c => c.Level == NodeLevels.Type ? 1 : 0).FirstOrDefault()
                        ?? s.Graph.Analysis.Cycles.FirstOrDefault(c => nodes.Select(n => index.ContainerOf(n, c.Level)).Any(x => x != null && c.Nodes.Contains(x)))
                        ?? throw new ToolException($"'{cycleRef}' is not in a cycle.");
            }

            DiIssue? issue = null;
            if (call.String("diIssue") is { } issueRef)
            {
                var finding = s.Findings.Findings.FirstOrDefault(f => f.Id == issueRef);
                var consumer = finding?.Nodes.FirstOrDefault() ?? Id("diIssue");
                issue = s.Graph.Analysis.Di?.Issues.FirstOrDefault(i => i.Consumer == consumer && (finding == null || finding.Nodes.Contains(i.Service)))
                        ?? throw new ToolException($"No DI issue for '{issueRef}'.");
                view = "di";
            }

            var flowRoots = call.List("flowRoots").Select(r => call.Node(s, r).Id).ToList();
            if (flowRoots.Count > 0) view = "flow";

            // A big map is drawn a level up unless asked otherwise: tens of thousands of points say little in a picture.
            level ??= view is "galaxy" or "layers" or "matrix" ? types > 3000 ? NodeLevels.Namespace : NodeLevels.Type : null;
            if (view == "layers" && level is NodeLevels.Type or NodeLevels.Member) level = types > 300 ? NodeLevels.Namespace : level;

            (string, string)? path = null;
            var pathNodes = call.List("path");
            if (pathNodes.Count > 0)
            {
                if (pathNodes.Count != 2) throw new ToolException("'path' needs two nodes: [from, to].");
                var unit = level is "project" or "namespace" or "type" ? level : NodeLevels.Type;
                string Unit(string q) { var n = call.Node(s, q); return index.ContainerOf(n.Id, unit) ?? n.Id; }
                path = (Unit(pathNodes[0]), Unit(pathNodes[1]));
            }

            var highlight = call.List("highlight").Select(h => call.Node(s, h).Id).ToList();
            var request = new RenderRequest
            {
                View = view,
                Level = level,
                Focus = call.String("focus") != null ? Id("focus") : null,
                Mode = call.Choice("mode", "neighbors", "neighbors", "dependencies", "dependents"),
                Path = path,
                Cycle = cycle,
                DiIssue = issue,
                FlowRoots = flowRoots.Count > 0 ? flowRoots : null,
                Highlight = highlight.Count > 0 ? highlight : null,
                Width = call.Int("width", 1280, 320, 2560),
                Height = call.Int("height", 800, 240, 1600),
            };

            RenderResult result;
            try
            {
                result = await call.Session.Renderer.RenderAsync(s.Graph, request, ct).ConfigureAwait(false);
            }
            catch (RenderUnavailableException ex)
            {
                throw new ToolException($"{ex.Message} The diagram tool draws the same structure as Mermaid text.");
            }

            return new ImageAnswer(result.Png, new
            {
                shows = result.Description,
                settled = result.Settled ? (bool?)null : false,
                pageErrors = result.Errors.Count > 0 ? result.Errors.Take(10).ToList() : null,
                renderer = MapRenderer.Renderer,
                size = $"{request.Width}×{request.Height}",
                note = "Colors: by project in galaxy; city height = complexity, color = hotspot; red links are upward dependencies or cycles; the legend lists the rest.",
            });
        });
}
