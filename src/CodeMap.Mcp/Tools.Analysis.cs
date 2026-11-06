using System.Globalization;
using System.Text.RegularExpressions;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Model;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;

namespace CodeMap.Mcp;

/// <summary>The tools of <c>codemap mcp</c>. All of them only read: the server never changes the code.</summary>
internal static partial class Tools
{
    private static readonly string[] Levels = { NodeLevels.Project, NodeLevels.Namespace, NodeLevels.Type, NodeLevels.Member };

    public static List<ToolDef> All() => new()
    {
        Analyze, Overview, SearchNodes, DescribeNode, ExplainDependency, ListFindings, ProposeRefactorings, Simulate, Compare, Snapshots, Diagram, CallFlowTool,
    };

    // ------------------------------------------------------------------ analyze

    private static readonly ToolDef Analyze = new("analyze", "Analyze code",
        "Analyzes a folder, solution (.sln/.slnx/.slnf), project (.csproj, package.json, tsconfig.json) or loads a saved .codemap.json, " +
        "and makes it the current map. Without a path: the server's root. Waits up to waitSeconds; a longer analysis keeps running and " +
        "analyze (without arguments) waits for it again. refresh: true analyzes the current path again after code changes; the old map " +
        "becomes 'previous'. Returns the size of the map, the health score and the worst findings.",
        """
        {"type":"object","properties":{
          "path":{"type":"string","description":"What to analyze, absolute or relative to the root. Default: the current map's path, else the root."},
          "refresh":{"type":"boolean","description":"Analyze again even if a map of this path exists (after editing code)."},
          "waitSeconds":{"type":"number","description":"How long to wait for the result (0-300, default 45)."},
          "git":{"type":"boolean","description":"Read git history for churn, hotspots and change coupling (default true)."},
          "checks":{"type":"boolean","description":"Check the code inside function bodies too: swallowed exceptions, sync over async, floating promises, unreachable code, compiler warnings that point at bugs (default true)."}
        }}
        """,
        async (call, ct) =>
        {
            var session = call.Session;
            await OfferRootsAsync(call, ct).ConfigureAwait(false);
            var given = call.String("path");
            var refresh = call.Bool("refresh", false);
            var wait = TimeSpan.FromSeconds(call.Int("waitSeconds", 45, 0, 300));
            var path = given != null ? session.Resolve(given) : session.Running?.Path ?? session.Current?.Path ?? session.RootOrCurrent;
            if (!File.Exists(path) && !Directory.Exists(path)) throw new ToolException($"Nothing at {path}.");

            if (!refresh && session.Running == null && session.Current is { } current && current.Path == path)
                return Summary(session, current, "done", reused: true);

            var analyzer = session.Options.Analyzer;
            if (call.String("git") != null || call.String("checks") != null) analyzer = new AnalyzerOptions
            {
                IncludeExternal = analyzer.IncludeExternal, IncludeGenerated = analyzer.IncludeGenerated, IncludeTests = analyzer.IncludeTests,
                GitSince = analyzer.GitSince, GitMaxCommits = analyzer.GitMaxCommits,
                Git = call.Bool("git", analyzer.Git), CodeChecks = call.Bool("checks", analyzer.CodeChecks),
            };

            var job = session.Running is { } running && running.Path == path && !refresh ? running : session.Start(path, analyzer);
            using var progress = Progress(call, job, ct);
            Snapshot? done;
            try
            {
                done = await CodeMapSession.WaitAsync(job, wait, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                throw new ToolException($"The analysis of {path} failed: {ex.Message}");
            }

            if (done != null) return Summary(session, done, "done", reused: false);
            return new
            {
                status = "running",
                path,
                elapsedSeconds = Math.Round(job.Clock.Elapsed.TotalSeconds),
                progress = job.LastLines(5),
                next = "Call analyze again (without arguments) to keep waiting.",
            };
        });

    private static object Summary(CodeMapSession session, Snapshot s, string status, bool reused)
    {
        var report = s.Findings;
        var g = s.Graph;
        return new
        {
            status,
            reused = reused ? true : (bool?)null,
            map = new
            {
                name = s.Name,
                path = s.Path,
                root = g.Source.Root,
                languages = g.Source.Languages?.Select(l => l.Id).ToList(),
                seconds = Math.Round(s.Seconds, 1),
                git = g.Source.Git is { } git ? $"{git.Branch} @ {git.Commit?[..Math.Min(8, git.Commit.Length)]}, {git.CommitsAnalyzed} commits" : null,
            },
            stats = new SortedDictionary<string, int>(g.Stats.Where(p => !p.Key.StartsWith("edges.", StringComparison.Ordinal)).ToDictionary(p => p.Key, p => p.Value), StringComparer.Ordinal),
            health = Answers.Score(report.Score),
            findings = new { total = report.Findings.Count, bySeverity = report.BySeverity, byCategory = report.ByCategory, worst = report.Findings.Take(8).Select(Answers.Brief).ToList() },
            codeChecks = g.Analysis.Diagnostics is { } diagnostics ? new { total = diagnostics.Count, byRule = diagnostics.GroupBy(d => d.Rule).OrderByDescending(x => x.Count()).Take(12).ToDictionary(x => x.Key, x => x.Count()) } : null,
            warnings = g.Analysis.Warnings.Take(10).ToList(),
            next = "overview for the architecture, list_findings for all problems, describe_node / explain_dependency for details, call_flow for what an entry point does.",
        };
    }

    /// <summary>Progress notifications while an analysis runs (when the client asked for them).</summary>
    private static IDisposable Progress(ToolCall call, AnalysisJob job, CancellationToken ct)
    {
        if (call.Request.Params?.ProgressToken is not { } token) return new Timer(_ => { });
        var sent = 0;
        return new Timer(_ =>
        {
            var lines = job.LastLines(1);
            if (job.Task.IsCompleted || lines.Length == 0) return;
            var step = Interlocked.Increment(ref sent);
            _ = call.Request.Server.NotifyProgressAsync(token, new ProgressNotificationValue { Progress = step, Message = lines[0] }, cancellationToken: ct);
        }, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2));
    }

    /// <summary>The client's first root becomes the server's root, unless one was given on the command line.</summary>
    private static async Task OfferRootsAsync(ToolCall call, CancellationToken ct)
    {
        if (call.Session.Root != null || call.Request.Server.ClientCapabilities?.Roots == null) return;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            var roots = await call.Request.Server.RequestRootsAsync(new ListRootsRequestParams(), timeout.Token).ConfigureAwait(false);
            var first = roots.Roots.FirstOrDefault(r => r.Uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase));
            if (first != null) call.Session.OfferRoot(new Uri(first.Uri).LocalPath);
        }
        catch (Exception ex) when (ex is McpException or OperationCanceledException or UriFormatException or TimeoutException)
        {
            // No roots: the current directory stays the root.
        }
    }

    // ------------------------------------------------------------------ overview

    private static readonly ToolDef Overview = new("overview", "Architecture overview",
        "The architecture at a glance: projects or namespaces with their size, coupling (Ca, Ce), instability, abstractness, distance from " +
        "the main sequence and layer; the computed layers with the upward dependencies that break them; the health score; findings by " +
        "severity and the worst of them; hotspots, the most depended-upon and most complex types; DI. mermaid: true adds a dependency diagram.",
        """
        {"type":"object","properties":{
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "level":{"type":"string","enum":["project","namespace"],"description":"Containers to list. Default: projects when there are several, else namespaces."},
          "limit":{"type":"number","description":"How many containers (default 30)."},
          "mermaid":{"type":"boolean","description":"Add a Mermaid diagram of the dependencies between the containers."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var g = s.Graph;
            var projects = g.Nodes.Count(n => n.Kind == NodeKinds.Project && !n.External);
            var level = call.Choice("level", projects >= 2 ? NodeLevels.Project : NodeLevels.Namespace, NodeLevels.Project, NodeLevels.Namespace);
            var kind = level == NodeLevels.Project ? NodeKinds.Project : NodeKinds.Namespace;
            var layering = g.Analysis.Layers.FirstOrDefault(l => l.Level == level);
            var layerOf = new Dictionary<string, int>(StringComparer.Ordinal);
            if (layering != null) for (var i = 0; i < layering.Layers.Count; i++) foreach (var id in layering.Layers[i]) layerOf[id] = i;
            string Name(string id) => s.Index.Node(id) is { } n ? n.Name.StartsWith('(') ? n.FullName ?? n.Name : n.Name : id;

            var containers = g.Nodes.Where(n => n.Kind == kind && !n.External)
                .OrderByDescending(n => layerOf.GetValueOrDefault(n.Id, -1)).ThenByDescending(n => n.Metric("types")).ThenBy(n => n.Id, StringComparer.Ordinal)
                .Take(call.Int("limit", 30, 1, 200))
                .Select(n => new
                {
                    id = n.Id,
                    name = Name(n.Id),
                    language = n.Language ?? (n.Project != null ? s.Index.Node(n.Project)?.Language : null),
                    layer = layerOf.TryGetValue(n.Id, out var layer) ? layer : (int?)null,
                    test = s.Index.IsTest(n) ? true : (bool?)null,
                    metrics = Answers.Metrics(n, new[] { "types", "loc", "complexity", "ca", "ce", "instability", "abstractness", "distance" }),
                })
                .ToList();

            var report = s.Findings;
            object? Ranked(List<RankedItem> items) => items.Count == 0 ? null : items.Take(10).Select(r => new { id = r.Id, name = s.Index.Node(r.Id)?.FullName ?? r.Id, score = Math.Round(r.Score, 3) }).ToList();
            return new
            {
                map = new { name = s.Name, languages = g.Source.Languages?.Select(l => l.Id).ToList(), stats = g.Stats.Where(p => !p.Key.StartsWith("edges.", StringComparison.Ordinal)).ToDictionary(p => p.Key, p => p.Value) },
                health = Answers.Score(report.Score),
                level,
                containers,
                layers = layering == null ? null : new
                {
                    count = layering.Layers.Count,
                    fromTop = Enumerable.Range(0, layering.Layers.Count).Reverse().Select(i => new { layer = i, members = layering.Layers[i].Take(20).Select(Name).ToList(), more = Math.Max(0, layering.Layers[i].Count - 20) }).ToList(),
                    upward = layering.Upward.Take(15).Select(e => new { from = Name(e.Source), to = Name(e.Target), weight = e.Weight, fromId = e.Source, toId = e.Target }).ToList(),
                    upwardTotal = layering.Upward.Count,
                },
                cycles = g.Analysis.Cycles.GroupBy(c => c.Level).ToDictionary(grp => grp.Key, grp => grp.Count()),
                findings = new { bySeverity = report.BySeverity, byCategory = report.ByCategory, byRule = report.ByRule, worst = report.Findings.Take(10).Select(Answers.Brief).ToList() },
                hotspots = Ranked(g.Analysis.Hotspots),
                mostDepended = Ranked(g.Analysis.MostDepended),
                mostComplex = Ranked(g.Analysis.MostComplex),
                di = g.Analysis.Di is { } di ? new { registrations = di.Registrations.Count, dependencies = di.Dependencies.Count, issues = di.Issues.GroupBy(i => i.Kind).ToDictionary(grp => grp.Key, grp => grp.Count()) } : null,
                mermaid = call.Bool("mermaid", false) ? MermaidExporter.Dependencies(s.Index, level) : null,
            };
        });

    // ------------------------------------------------------------------ search_nodes

    private static readonly ToolDef SearchNodes = new("search_nodes", "Search the map",
        "Finds nodes (projects, namespaces/folders, types/files, members) by name, kind, level, tags and metric range, sorted by a metric. " +
        "Use it to find candidates (e.g. the most complex methods: level member, sort complexity) or the id of something to describe.",
        """
        {"type":"object","properties":{
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "query":{"type":"string","description":"Part of the name or full name (case-insensitive); * and ? are wildcards."},
          "kind":{"type":"array","items":{"type":"string"},"description":"Node kinds, e.g. class, interface, method, function, module, namespace, project."},
          "level":{"type":"string","enum":["project","namespace","type","member"]},
          "tags":{"type":"array","items":{"type":"string"},"description":"All of these tags, e.g. controller, unused, in-cycle, hotspot, test, di-issue, singleton."},
          "within":{"type":"string","description":"Only nodes inside this project, namespace or type (id or name)."},
          "metric":{"type":"string","description":"Metric to filter on and sort by: loc, complexity, ca, ce, instability, members, fanIn, fanOut, commits, hotspot…"},
          "min":{"type":"number"},"max":{"type":"number"},
          "includeExternal":{"type":"boolean","description":"Also framework / package types (default false)."},
          "includeTests":{"type":"boolean","description":"Also test code (default true)."},
          "limit":{"type":"number","description":"Default 20, at most 200."},
          "cursor":{"type":"string","description":"nextCursor of the previous page."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            IEnumerable<GraphNode> nodes = s.Graph.Nodes;
            if (!call.Bool("includeExternal", false)) nodes = nodes.Where(n => !n.External);
            if (!call.Bool("includeTests", true)) nodes = nodes.Where(n => !s.Index.IsTest(n));
            if (call.String("query") is { } query)
            {
                var pattern = new Regex(query.Contains('*') || query.Contains('?') ? "^" + Regex.Escape(query).Replace("\\*", ".*").Replace("\\?", ".") + "$" : Regex.Escape(query),
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                nodes = nodes.Where(n => pattern.IsMatch(n.Name) || n.FullName != null && pattern.IsMatch(n.FullName) || pattern.IsMatch(n.Id));
            }

            var kinds = call.List("kind");
            if (kinds.Count > 0) nodes = nodes.Where(n => kinds.Contains(n.Kind, StringComparer.OrdinalIgnoreCase));
            if (call.String("level") is { } level)
            {
                level = call.Choice("level", level, Levels);
                nodes = nodes.Where(n => NodeLevels.Of(n) == level);
            }

            var tags = call.List("tags");
            if (tags.Count > 0) nodes = nodes.Where(n => tags.All(n.HasTag));
            if (call.String("within") is { } within)
            {
                var scope = call.Node(s, within);
                nodes = nodes.Where(n => n.Id != scope.Id && s.Index.AncestorsAndSelf(n).Any(a => a.Id == scope.Id) || n.Project == scope.Id);
            }

            var metric = call.String("metric");
            var (min, max) = (call.Number("min"), call.Number("max"));
            if (metric != null)
            {
                nodes = nodes.Where(n => n.Metrics?.ContainsKey(metric) == true);
                if (min != null) nodes = nodes.Where(n => n.Metric(metric) >= min);
                if (max != null) nodes = nodes.Where(n => n.Metric(metric) <= max);
                nodes = nodes.OrderByDescending(n => n.Metric(metric)).ThenBy(n => n.Id, StringComparer.Ordinal);
            }
            else
            {
                nodes = nodes.OrderBy(n => Array.IndexOf(Levels, NodeLevels.Of(n))).ThenBy(n => n.FullName ?? n.Name, StringComparer.Ordinal);
            }

            var all = nodes.ToList();
            var (start, limit) = call.Page();
            var shown = new[] { "loc", "complexity", "ca", "ce", "members" }.Append(metric ?? "").ToHashSet(StringComparer.Ordinal);
            return new
            {
                total = all.Count,
                items = all.Skip(start).Take(limit).Select(n => new
                {
                    id = n.Id,
                    name = n.FullName ?? n.Name,
                    kind = n.Kind,
                    level = NodeLevels.Of(n),
                    at = Answers.At(n),
                    tags = n.Tags is { Count: > 0 } ? n.Tags : null,
                    metrics = Answers.Metrics(n, shown),
                }).ToList(),
                nextCursor = Answers.Next(start, limit, all.Count),
            };
        });

    // ------------------------------------------------------------------ describe_node

    private static readonly ToolDef DescribeNode = new("describe_node", "Describe a node",
        "Everything the map knows about one node: declaration and place in the code, metrics, tags, its members, what it depends on and " +
        "what depends on it (rolled up to its level, with weights and kinds), calls and callers of a member, DI registrations and " +
        "injections, the cycles and findings it is part of.",
        """
        {"type":"object","required":["node"],"properties":{
          "node":{"type":"string","description":"Id, full name, name, or the end of a full name (Orders.OrderService)."},
          "graph":{"type":"string","description":"current (default), previous, a baseline name or a .codemap.json path."},
          "limit":{"type":"number","description":"Items per list (members, dependencies…), default 20."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var node = call.Node(s, call.Required("node"));
            var limit = call.Int("limit", 20, 1, 200);
            var index = s.Index;
            var level = NodeLevels.Of(node);
            string Name(string id) => index.Node(id)?.FullName ?? index.Node(id)?.Name ?? id;

            object? Deps(IEnumerable<Dependency> deps, bool outgoing)
            {
                var list = deps.OrderByDescending(d => d.Weight).ThenBy(d => outgoing ? d.Target : d.Source, StringComparer.Ordinal).ToList();
                if (list.Count == 0) return null;
                return new
                {
                    total = list.Count,
                    items = list.Take(limit).Select(d => new
                    {
                        id = outgoing ? d.Target : d.Source,
                        name = Name(outgoing ? d.Target : d.Source),
                        weight = d.Weight,
                        kinds = d.Kinds,
                        at = index.Where(d.Edges[0])?.ToString(),
                    }).ToList(),
                };
            }

            object? Edges(IEnumerable<GraphEdge> edges, bool outgoing) =>
                edges.Where(e => e.Kind is not EdgeKinds.ChangesWith).GroupBy(e => e.Kind).OrderBy(g => g.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g
                    .OrderBy(e => e.Line == 0 ? int.MaxValue : e.Line).Take(limit)
                    .Select(e => new { id = outgoing ? e.Target : e.Source, name = Name(outgoing ? e.Target : e.Source), weight = e.Weight, at = index.Where(e)?.ToString() }).ToList()) is { Count: > 0 } d ? d : null;

            var members = index.Children(node.Id).Where(NodeLevels.IsMember).ToList();
            var di = s.Graph.Analysis.Di;
            var cycles = s.Graph.Analysis.Cycles.Where(c => c.Nodes.Contains(node.Id)).Select(c => new { level = c.Level, size = c.Nodes.Count, nodes = c.Nodes.Take(12).Select(Name).ToList() }).ToList();
            var findings = s.Findings.Findings.Where(f => f.Nodes.Contains(node.Id)).Take(limit).Select(Answers.Brief).ToList();
            var layer = s.Graph.Analysis.Layers.FirstOrDefault(l => l.Level == level) is { } info ? info.Layers.FindIndex(l => l.Contains(node.Id)) : -1;
            var dependencyLevel = level == NodeLevels.Member ? null : level;

            return new
            {
                node = new
                {
                    id = node.Id,
                    name = node.Name,
                    fullName = node.FullName,
                    kind = node.Kind,
                    level,
                    signature = node.Signature,
                    accessibility = node.Accessibility,
                    modifiers = node.Modifiers,
                    baseType = node.BaseType,
                    doc = node.Doc,
                    at = node.Location is { } l ? $"{l.File}:{l.Line}-{l.EndLine}" : null,
                    alsoAt = node.ExtraLocations?.Select(Answers.At).ToList(),
                    tags = node.Tags,
                    attributes = node.Attributes,
                    metrics = Answers.Metrics(node),
                    external = node.External ? true : (bool?)null,
                    test = index.IsTest(node) ? true : (bool?)null,
                },
                inside = index.AncestorsAndSelf(node).Skip(1).Select(a => new { id = a.Id, name = a.FullName ?? a.Name, kind = a.Kind }).ToList(),
                layer = layer >= 0 ? layer : (int?)null,
                members = members.Count == 0 ? null : new
                {
                    total = members.Count,
                    byKind = members.GroupBy(m => m.Kind).ToDictionary(g => g.Key, g => g.Count()),
                    items = members.OrderByDescending(m => m.Metric("complexity")).ThenBy(m => m.Name, StringComparer.Ordinal).Take(limit)
                        .Select(m => new { id = m.Id, name = m.Name, kind = m.Kind, signature = m.Signature, at = Answers.At(m), metrics = Answers.Metrics(m, new[] { "loc", "complexity", "fanIn", "fanOut" }), tags = m.Tags }).ToList(),
                },
                dependsOn = dependencyLevel != null ? Deps(index.DependenciesOf(node.Id, dependencyLevel), true) : null,
                usedBy = dependencyLevel != null ? Deps(index.DependentsOf(node.Id, dependencyLevel), false) : null,
                outgoing = level == NodeLevels.Member ? Edges(index.Outgoing(node.Id), true) : null,
                incoming = level == NodeLevels.Member ? Edges(index.Incoming(node.Id), false) : null,
                di = di == null ? null : new
                {
                    registrations = di.Registrations.Where(r => r.Service == node.Id || r.Implementation == node.Id)
                        .Select(r => new { service = Name(r.Service), implementation = r.Implementation != null ? Name(r.Implementation) : null, lifetime = r.Effective ?? r.Lifetime, r.Kind, r.Key, at = Answers.At(r.Location) }).ToList(),
                    injects = di.Dependencies.Where(d => d.Consumer == node.Id)
                        .Select(d => new { service = Name(d.Service), implementations = d.Implementations.Select(Name).ToList(), lifetime = d.Lifetime, many = d.Many ? true : (bool?)null }).ToList(),
                    injectedInto = di.Dependencies.Where(d => d.Implementations.Contains(node.Id) || d.Service == node.Id)
                        .Select(d => new { consumer = Name(d.Consumer), lifetime = d.ConsumerLifetime }).Take(limit).ToList(),
                    issues = di.Issues.Where(i => i.Consumer == node.Id || i.Service == node.Id).Select(i => new { i.Kind, i.Severity, i.Message }).ToList(),
                },
                cycles = cycles.Count > 0 ? cycles : null,
                findings = findings.Count > 0 ? findings : null,
            };
        });
}
