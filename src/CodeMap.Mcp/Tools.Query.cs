using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Model;

namespace CodeMap.Mcp;

internal static partial class Tools
{
    // ------------------------------------------------------------------ explain_dependency

    private static readonly ToolDef ExplainDependency = new("explain_dependency", "Explain a dependency",
        "Why A depends on B: the concrete references behind it (which member uses what, of which kind, at file:line), whether it points " +
        "up against the layers or is part of a cycle, and whether B also depends on A. Without a direct dependency: the shortest chains " +
        "of type dependencies from A to B.",
        """
        {"type":"object","required":["from","to"],"properties":{
          "from":{"type":"string","description":"The dependent node (id or name): a project, namespace, type or member."},
          "to":{"type":"string","description":"The node it depends on."},
          "level":{"type":"string","enum":["project","namespace","type"],"description":"Compare at this level (default: the coarser level of the two)."},
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "limit":{"type":"number","description":"References to list (default 20)."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var index = s.Index;
            var from = call.Node(s, call.Required("from"));
            var to = call.Node(s, call.Required("to"));
            var limit = call.Int("limit", 20, 1, 200);
            static int Rank(string level) => level switch { NodeLevels.Project => 0, NodeLevels.Namespace => 1, _ => 2 };
            var level = call.String("level") is { } given
                ? call.Choice("level", given, NodeLevels.Project, NodeLevels.Namespace, NodeLevels.Type)
                : new[] { NodeLevels.Of(from), NodeLevels.Of(to) }.Select(l => l == NodeLevels.Member ? NodeLevels.Type : l).OrderBy(Rank).First();
            var a = index.ContainerOf(from.Id, level) ?? throw new ToolException($"{from.Id} is not inside a {level}.");
            var b = index.ContainerOf(to.Id, level) ?? throw new ToolException($"{to.Id} is not inside a {level}.");
            string Name(string id) => index.Node(id)?.FullName ?? index.Node(id)?.Name ?? id;
            if (a == b) throw new ToolException($"Both are in {Name(a)} at the {level} level; pick a finer level.");

            // Only the references of the given nodes when they are finer than the level (a member, a type in a namespace).
            bool Within(string id, GraphNode scope) => index.Node(id) is { } n && index.AncestorsAndSelf(n).Any(x => x.Id == scope.Id);
            var direct = index.DependencyBetween(a, b, level);
            var references = direct?.Edges.Where(e => Within(e.Source, from) && Within(e.Target, to)).ToList() ?? new List<GraphEdge>();
            var reverse = index.DependencyBetween(b, a, level);
            var upward = s.Graph.Analysis.Layers.FirstOrDefault(l => l.Level == level)?.Upward.Any(u => u.Source == a && u.Target == b) == true;
            var cycle = s.Graph.Analysis.Cycles.FirstOrDefault(c => c.Level == level && c.Nodes.Contains(a) && c.Nodes.Contains(b));

            object Reference(GraphEdge e) => new { from = Name(e.Source), kind = e.Kind, to = Name(e.Target), weight = e.Weight, at = index.Where(e)?.ToString() };

            List<List<object>>? paths = null;
            if (references.Count == 0)
            {
                paths = ShortestPaths(index, from, to, maxPaths: 3).Select(path => path.Select(d => (object)new
                {
                    from = Name(d.Source),
                    to = Name(d.Target),
                    weight = d.Weight,
                    at = index.Where(d.Edges[0])?.ToString(),
                }).ToList()).ToList();
            }

            return new
            {
                level,
                from = Name(a),
                to = Name(b),
                direct = references.Count > 0,
                weight = references.Sum(e => e.Weight),
                kinds = references.GroupBy(e => e.Kind).ToDictionary(g => g.Key, g => g.Sum(e => e.Weight)),
                references = references.Take(limit).Select(Reference).ToList(),
                moreReferences = Math.Max(0, references.Count - limit),
                upward = upward ? true : (bool?)null,
                cycle = cycle == null ? null : new { size = cycle.Nodes.Count, nodes = cycle.Nodes.Take(12).Select(Name).ToList() },
                reverse = reverse == null ? null : new { weight = reverse.Weight, kinds = reverse.Kinds, first = index.Where(reverse.Edges[0])?.ToString() },
                paths = paths is { Count: > 0 } ? paths : null,
                findings = s.Findings.Findings.Where(f => f.Nodes.Contains(a) && f.Nodes.Contains(b)).Select(Answers.Brief).ToList(),
                note = references.Count == 0 && paths is not { Count: > 0 } ? $"{Name(a)} does not reach {Name(b)} through code dependencies." : null,
            };
        });

    /// <summary>The shortest chains of type dependencies from the types of one node to those of another (breadth first).</summary>
    private static List<List<Dependency>> ShortestPaths(GraphIndex index, GraphNode from, GraphNode to, int maxPaths)
    {
        HashSet<string> TypesOf(GraphNode node) => NodeLevels.Of(node) switch
        {
            NodeLevels.Type => new HashSet<string>(StringComparer.Ordinal) { node.Id },
            NodeLevels.Member => index.TypeOf(node.Id) is { } t ? new HashSet<string>(StringComparer.Ordinal) { t } : new HashSet<string>(StringComparer.Ordinal),
            _ => index.Graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && index.AncestorsAndSelf(n).Any(a => a.Id == node.Id)).Select(n => n.Id).ToHashSet(StringComparer.Ordinal),
        };

        var sources = TypesOf(from);
        var targets = TypesOf(to);
        var parent = new Dictionary<string, Dependency?>(StringComparer.Ordinal);
        var queue = new Queue<string>();
        foreach (var id in sources.OrderBy(i => i, StringComparer.Ordinal))
        {
            parent[id] = null;
            queue.Enqueue(id);
        }

        var found = new List<List<Dependency>>();
        while (queue.Count > 0 && found.Count < maxPaths && parent.Count < 200_000)
        {
            var id = queue.Dequeue();
            foreach (var d in index.DependenciesOf(id, NodeLevels.Type).OrderByDescending(d => d.Weight).ThenBy(d => d.Target, StringComparer.Ordinal))
            {
                if (parent.ContainsKey(d.Target)) continue;
                parent[d.Target] = d;
                if (targets.Contains(d.Target))
                {
                    var path = new List<Dependency>();
                    for (var step = d; step != null; step = parent[step.Source]) path.Add(step);
                    path.Reverse();
                    found.Add(path);
                    if (found.Count >= maxPaths) break;
                    continue;
                }

                queue.Enqueue(d.Target);
            }
        }

        return found;
    }

    // ------------------------------------------------------------------ list_findings

    private static readonly ToolDef ListFindings = new("list_findings", "List findings",
        "Problems in the structure, worst first, each with evidence (nodes, file:line, numbers against thresholds) and a suggestion: " +
        "spaghetti (cycles with their cheapest cut, tangles, hubs, god classes, feature envy, hidden change coupling, hotspots), structure " +
        "(layer violations, stability, sizes, inheritance, middle men, tiny modules, test code in production), DI and dead code. " +
        "The rules are described in the resource codemap://rules.",
        """
        {"type":"object","properties":{
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "category":{"type":"string","enum":["spaghetti","structure","di","dead-code","code"]},
          "rule":{"type":"string","description":"A rule id (cycle.namespace, god-class…) or its start (cycle, di)."},
          "severity":{"type":"string","enum":["error","warning","info"],"description":"At least this severe (default info: all)."},
          "within":{"type":"string","description":"Only findings about nodes inside this project, namespace or type (id or name), or under this folder path."},
          "detail":{"type":"string","enum":["brief","full"],"description":"brief (default): one line each; full: all evidence, locations and facts."},
          "includeTests":{"type":"boolean","description":"Also look at test code (default false)."},
          "limit":{"type":"number","description":"Default 20, at most 200."},
          "cursor":{"type":"string","description":"nextCursor of the previous page."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var report = call.Bool("includeTests", false) ? FindingsAnalysis.Compute(s.Graph, new FindingOptions { IncludeTests = true }, s.Index) : s.Findings;
            IEnumerable<Finding> findings = report.Findings;
            if (call.String("category") is { } category) findings = findings.Where(f => f.Category.Equals(category, StringComparison.OrdinalIgnoreCase));
            if (call.String("rule") is { } rule) findings = findings.Where(f => f.Rule.Equals(rule, StringComparison.OrdinalIgnoreCase) || f.Rule.StartsWith(rule + ".", StringComparison.OrdinalIgnoreCase));
            var severity = call.Choice("severity", FindingSeverity.Info, FindingSeverity.Error, FindingSeverity.Warning, FindingSeverity.Info);
            findings = findings.Where(f => FindingSeverity.Order(f.Severity) <= FindingSeverity.Order(severity));
            if (call.String("within") is { } within)
            {
                var folder = within.Replace('\\', '/').TrimEnd('/');
                var scope = within.Contains('/') ? null : call.Node(s, within);
                findings = findings.Where(f => scope != null
                    ? f.Nodes.Any(id => s.Index.Node(id) is { } n && (s.Index.AncestorsAndSelf(n).Any(x => x.Id == scope.Id) || n.Project == scope.Id))
                    : f.Locations.Any(l => l.File.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase) || l.File.Equals(folder, StringComparison.OrdinalIgnoreCase)));
            }

            var list = findings.ToList();
            var (start, limit) = call.Page();
            var full = call.Choice("detail", "brief", "brief", "full") == "full";
            return new
            {
                health = new { report.Score.Score, report.Score.Grade, report.Score.Summary },
                total = list.Count,
                bySeverity = list.GroupBy(f => f.Severity).ToDictionary(g => g.Key, g => g.Count()),
                items = list.Skip(start).Take(limit).Select(f => full ? (object)f : Answers.Brief(f)).ToList(),
                nextCursor = Answers.Next(start, limit, list.Count),
            };
        });

    // ------------------------------------------------------------------ snapshots

    private static readonly ToolDef Snapshots = new("snapshots", "Snapshots",
        "Lists the graphs the session holds (current, previous, saved baselines), saves the current map as a named baseline (before " +
        "refactoring, to compare with after) or deletes one. Any tool takes a baseline's name as its graph.",
        """
        {"type":"object","properties":{
          "action":{"type":"string","enum":["list","save","delete"],"description":"Default list."},
          "name":{"type":"string","description":"Baseline name for save / delete (default: baseline)."}
        }}
        """,
        async (call, ct) =>
        {
            var session = call.Session;
            var action = call.Choice("action", "list", "list", "save", "delete");
            var name = call.String("name") ?? "baseline";
            if (name is "current" or "previous") throw new ToolException("'current' and 'previous' are kept by the session; pick another name.");
            switch (action)
            {
                case "save":
                    session.Save(name, await session.GraphAsync(null, ct).ConfigureAwait(false));
                    break;
                case "delete":
                    if (!session.Delete(name)) throw new ToolException($"No baseline '{name}'.");
                    break;
            }

            object Describe(string label, Snapshot? s) => s == null ? new { name = label, missing = true } : new
            {
                name = label,
                graph = s.Name,
                path = s.Path,
                origin = s.Origin,
                analyzedAt = s.At.ToString("u", System.Globalization.CultureInfo.InvariantCulture),
                types = s.Graph.Stats.GetValueOrDefault("types"),
                score = s.Findings.Score.Score,
                findings = s.Findings.Findings.Count,
            };

            return new
            {
                done = action == "list" ? null : $"{action}d {name}",
                current = session.Current == null ? null : Describe("current", session.Current),
                previous = session.Previous == null ? null : Describe("previous", session.Previous),
                baselines = session.BaselineNames().Select(b => new { name = b, onDisk = session.IsSpilled(b) ? true : (bool?)null }).ToList(),
            };
        });

    // ------------------------------------------------------------------ diagram

    private static readonly ToolDef Diagram = new("diagram", "Mermaid diagram",
        "A Mermaid diagram of part of the map: dependencies between projects/namespaces/types (around given nodes, or the most coupled), " +
        "the computed layers with upward dependencies in red, one cycle with its cheapest cut, a class with its neighbours, the DI wiring " +
        "with lifetimes, or the sequence diagram of a call flow. At most maxNodes nodes; the rest is counted in a note.",
        """
        {"type":"object","required":["kind"],"properties":{
          "kind":{"type":"string","enum":["dependencies","layers","cycle","class","di","sequence"]},
          "level":{"type":"string","enum":["project","namespace","type"],"description":"For dependencies, layers and cycle (default namespace; type for cycles of types)."},
          "nodes":{"type":"array","items":{"type":"string"},"description":"Focus: nodes to center on (dependencies, di), the type (class), a node of the cycle (cycle), the method or type (sequence)."},
          "finding":{"type":"string","description":"For cycle: the id of a cycle finding (cycle.namespace@…)."},
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "maxNodes":{"type":"number","description":"Default 40."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var kind = call.Choice("kind", "dependencies", "dependencies", "layers", "cycle", "class", "di", "sequence");
            var maxNodes = call.Int("maxNodes", 40, 2, 150);
            var focus = call.List("nodes").Select(n => call.Node(s, n)).ToList();
            string? level = call.String("level") is { } l ? call.Choice("level", l, NodeLevels.Project, NodeLevels.Namespace, NodeLevels.Type) : null;
            string mermaid;
            switch (kind)
            {
                case "dependencies":
                    level ??= focus.Count > 0 ? NodeLevels.Of(focus[0]) is NodeLevels.Member ? NodeLevels.Type : NodeLevels.Of(focus[0]) : NodeLevels.Namespace;
                    var ids = focus.Select(f => s.Index.ContainerOf(f.Id, level) ?? f.Id).ToList();
                    mermaid = MermaidExporter.Dependencies(s.Index, level, ids, maxNodes);
                    break;
                case "layers":
                    mermaid = MermaidExporter.Layers(s.Index, level ?? NodeLevels.Namespace, maxNodes);
                    break;
                case "cycle":
                    CycleInfo? cycle;
                    if (call.String("finding") is { } findingId)
                    {
                        var finding = s.Findings.Findings.FirstOrDefault(f => f.Id == findingId) ?? throw new ToolException($"No finding {findingId}.");
                        cycle = s.Graph.Analysis.Cycles.FirstOrDefault(c => finding.Nodes.Count > 0 && c.Nodes.ToHashSet().SetEquals(finding.Nodes))
                                ?? s.Graph.Analysis.Cycles.FirstOrDefault(c => finding.Nodes.All(c.Nodes.Contains));
                    }
                    else if (focus.Count > 0)
                    {
                        var target = focus[0];
                        var lvl = level ?? (NodeLevels.Of(target) is NodeLevels.Member ? NodeLevels.Type : NodeLevels.Of(target));
                        var id = s.Index.ContainerOf(target.Id, lvl) ?? target.Id;
                        cycle = s.Graph.Analysis.Cycles.FirstOrDefault(c => c.Level == lvl && c.Nodes.Contains(id));
                    }
                    else
                    {
                        cycle = s.Graph.Analysis.Cycles.Where(c => level == null || c.Level == level).OrderBy(c => c.Level == NodeLevels.Type ? 1 : 0).ThenByDescending(c => c.Nodes.Count).FirstOrDefault();
                    }

                    if (cycle == null) throw new ToolException("No such cycle: give a cycle finding id or a node in a cycle (list_findings rule: cycle).");
                    mermaid = MermaidExporter.Cycle(s.Index, cycle.Nodes, cycle.Level, maxNodes);
                    break;
                case "class":
                    var type = focus.FirstOrDefault() ?? throw new ToolException("'nodes' needs the type to draw.");
                    if (NodeLevels.IsMember(type) && !ClassMetrics.IsClass(type)) type = s.Index.Node(s.Index.TypeOf(type.Id) ?? type.Id)!;
                    mermaid = MermaidExporter.Class(s.Index, type.Id);
                    break;
                case "di":
                    mermaid = MermaidExporter.Di(s.Index, focus.Select(f => f.Id).ToList(), maxNodes);
                    break;
                default:
                    var root = focus.FirstOrDefault() ?? throw new ToolException("'nodes' needs the method (or type) whose flow to draw.");
                    var flow = s.Flow.Build(new[] { root.Id });
                    if (flow.Tree.Count == 0) throw new ToolException($"{root.Id} starts no call flow (call_flow lists the entry points).");
                    mermaid = string.Join("\n", flow.Tree.Take(3).Select(s.Flow.ToMermaid));
                    break;
            }

            return new { kind, level, mermaid };
        });

    // ------------------------------------------------------------------ call_flow

    private static readonly ToolDef CallFlowTool = new("call_flow", "Call flow",
        "What happens when an entry point runs: calls in source order, through interfaces to the implementation the DI container injects. " +
        "Without roots: the likely entry points (controllers, hubs, background services, handlers, middleware, Main, routes) with how much " +
        "code each reaches. With roots (methods, or types for all their entry methods): the call tree and a Mermaid sequence diagram.",
        """
        {"type":"object","properties":{
          "roots":{"type":"array","items":{"type":"string"},"description":"Methods or types to start from (ids or names)."},
          "maxDepth":{"type":"number","description":"Call depth (default 8)."},
          "includeTests":{"type":"boolean","description":"Follow calls into test code (default false)."},
          "mermaid":{"type":"boolean","description":"Sequence diagrams (default true)."},
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "limit":{"type":"number","description":"Entry points or flows to show (default 20)."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var limit = call.Int("limit", 20, 1, 100);
            string Name(GraphNode n) => s.Flow.OwnerOf(n) is { } owner && owner != n ? $"{owner.Name}.{n.Name}" : n.Name;
            var roots = call.List("roots").Select(r => call.Node(s, r)).ToList();
            if (roots.Count == 0)
            {
                return new
                {
                    entryPoints = s.Flow.FindEntryPoints(limit).Select(e => new
                    {
                        id = e.Node.Id,
                        name = e.Node.FullName ?? e.Node.Name,
                        role = e.Role,
                        reach = e.Reach,
                        at = Answers.At(e.Node),
                        methods = e.Methods.Take(12).Select(m => new { id = m.Id, name = m.Name }).ToList(),
                    }).ToList(),
                    next = "call_flow with roots: [an entry point or method id] for its flow and sequence diagram.",
                };
            }

            var flow = s.Flow.Build(roots.Select(r => r.Id), maxDepth: call.Int("maxDepth", 8, 1, 30), showTests: call.Bool("includeTests", false));
            var budget = 400;
            object Tree(CallFlow.Step step, CallFlow.Step? caller)
            {
                budget--;
                var children = budget <= 0 ? new List<object>() : step.Children.Where(c => c.Kind != "create").Select(c => Tree(c, step)).ToList();
                var callerFile = caller != null ? s.Index.AncestorsAndSelf(caller.Node).Select(n => n.Location?.File).FirstOrDefault(f => f != null) : null;
                return new
                {
                    call = Name(step.Node),
                    id = step.Id,
                    calledAt = callerFile != null && step.Line > 0 ? $"{callerFile}:{step.Line}" : null,
                    declaredAt = Answers.At(step.Node),
                    via = step.Dispatch is { } d ? new { implementations = d.Targets.Select(t => Tree(t, caller)).ToList(), narrowedByDi = d.Narrowed ? true : (bool?)null, total = d.Total } : null,
                    creates = step.Children.Where(c => c.Kind == "create").Select(c => c.Node.Name).Distinct().ToList() is { Count: > 0 } created ? created : null,
                    note = step.Recursive ? "recursion" : step.Repeat ? "expanded above" : step.Truncated ? "deeper calls not shown" : null,
                    calls = children.Count > 0 ? children : null,
                };
            }

            return new
            {
                stats = new { methods = flow.Methods.Count, types = flow.Types, depth = flow.Depth, truncated = flow.Truncated ? true : (bool?)null },
                flows = flow.Tree.Take(limit).Select(root => new
                {
                    root = Name(root.Node),
                    id = root.Id,
                    at = Answers.At(root.Node),
                    mermaid = call.Bool("mermaid", true) ? s.Flow.ToMermaid(root) : null,
                    tree = Tree(root, null),
                }).ToList(),
            };
        });
}
