using System.IO.Pipelines;
using System.Text.Json;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Languages;
using CodeMap.Mcp;
using CodeMap.Model;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace CodeMap.Tests;

/// <summary>
/// codemap mcp through the protocol, in process: an MCP client talks to the server over pipes, as an agent would over stdio.
/// </summary>
public sealed class McpServerTests
{
    private static string ShopSln => Path.Combine(GoldenTests.RepoRoot(), "samples", "Shop", "Shop.sln");

    /// <summary>A server on a session and a client connected to it.</summary>
    private sealed class Connection : IAsyncDisposable
    {
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _running;
        private readonly McpServer _server;

        private Connection(CodeMapSession session, McpServer server, McpClient client, Task running)
        {
            Session = session;
            _server = server;
            Client = client;
            _running = running;
        }

        public CodeMapSession Session { get; }
        public McpClient Client { get; }

        public static async Task<Connection> OpenAsync(CodeMapMcpOptions? options = null)
        {
            var session = new CodeMapSession(options ?? new CodeMapMcpOptions { Analyzer = new AnalyzerOptions { Git = false }, Watch = false, Registry = () => LanguageRegistry.BuiltIn });
            var toServer = new Pipe();
            var toClient = new Pipe();
            var server = McpServer.Create(new StreamServerTransport(toServer.Reader.AsStream(), toClient.Writer.AsStream(), "codemap"), CodeMapMcpServer.CreateOptions(session));
            var stop = new CancellationTokenSource();
            var running = server.RunAsync(stop.Token);
            var client = await McpClient.CreateAsync(new StreamClientTransport(toServer.Writer.AsStream(), toClient.Reader.AsStream()));
            var connection = new Connection(session, server, client, running);
            connection._stop.Token.Register(stop.Cancel);
            return connection;
        }

        /// <summary>Calls a tool and returns its JSON answer (and whether it is an error).</summary>
        public async Task<(JsonElement Json, string Text, bool Error)> CallAsync(string tool, object? args = null)
        {
            var arguments = args == null
                ? new Dictionary<string, object?>()
                : JsonSerializer.SerializeToElement(args).EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value);
            var result = await Client.CallToolAsync(tool, arguments);
            var text = string.Concat(result.Content.OfType<TextContentBlock>().Select(t => t.Text));
            if (result.IsError == true) return (default, text, true);
            Assert.NotNull(result.StructuredContent);
            return (result.StructuredContent!.Value, text, false);
        }

        public async ValueTask DisposeAsync()
        {
            await Client.DisposeAsync();
            _stop.Cancel();
            try { await _running; }
            catch (OperationCanceledException) { }
            await _server.DisposeAsync();
            Session.Dispose();
        }
    }

    private static async Task<Connection> ShopAsync()
    {
        var connection = await Connection.OpenAsync();
        var (json, _, error) = await connection.CallAsync("analyze", new { path = ShopSln, waitSeconds = 120 });
        Assert.False(error);
        Assert.Equal("done", json.GetProperty("status").GetString());
        return connection;
    }

    [Fact]
    public async Task The_server_introduces_itself_and_its_tools()
    {
        await using var c = await Connection.OpenAsync();
        Assert.Equal("codemap", c.Client.ServerInfo.Name);
        Assert.Contains("analyze", c.Client.ServerInstructions);

        var tools = await c.Client.ListToolsAsync();
        Assert.Equal(new[] { "analyze", "call_flow", "compare", "describe_node", "diagram", "explain_dependency", "list_findings", "overview", "propose_refactorings", "render_map", "search_nodes", "simulate", "snapshots" },
            tools.Select(t => t.Name).Order(StringComparer.Ordinal));
        Assert.All(tools, t =>
        {
            Assert.Equal("object", t.JsonSchema.GetProperty("type").GetString());
            Assert.True(t.ProtocolTool.Annotations?.ReadOnlyHint);
            Assert.False(string.IsNullOrWhiteSpace(t.Description));
        });

        var prompts = await c.Client.ListPromptsAsync();
        Assert.Equal(new[] { "check_changes", "plan_refactoring", "review_architecture" }, prompts.Select(p => p.Name).Order(StringComparer.Ordinal));
        var review = await c.Client.GetPromptAsync("review_architecture", new Dictionary<string, object?> { ["focus"] = "Shop.Domain" });
        Assert.Contains("Shop.Domain", ((TextContentBlock)review.Messages[0].Content).Text);

        var rules = await c.Client.ReadResourceAsync("codemap://rules");
        var catalog = JsonDocument.Parse(((TextResourceContents)rules.Contents[0]).Text).RootElement;
        Assert.Contains(catalog.EnumerateArray(), r => r.GetProperty("id").GetString() == "god-class");
    }

    [Fact]
    public async Task Analyze_gives_the_map_its_score_and_worst_findings_and_overview_the_architecture()
    {
        await using var c = await ShopAsync();
        var (analysis, _, _) = await c.CallAsync("analyze", new { path = ShopSln });
        Assert.True(analysis.GetProperty("reused").GetBoolean());
        Assert.InRange(analysis.GetProperty("health").GetProperty("score").GetInt32(), 1, 100);
        Assert.Equal("di.captive", analysis.GetProperty("findings").GetProperty("worst")[0].GetProperty("rule").GetString());
        Assert.Equal("Shop", analysis.GetProperty("meta").GetProperty("graph").GetProperty("name").GetString());

        var (overview, _, _) = await c.CallAsync("overview", new { mermaid = true });
        Assert.Equal("project", overview.GetProperty("level").GetString());
        var containers = overview.GetProperty("containers").EnumerateArray().Select(e => e.GetProperty("name").GetString()).ToList();
        Assert.Contains("Shop.Domain", containers);
        Assert.StartsWith("flowchart LR", overview.GetProperty("mermaid").GetString());
        Assert.True(overview.GetProperty("layers").GetProperty("count").GetInt32() >= 2);
    }

    [Fact]
    public async Task Findings_are_paged_and_filtered()
    {
        await using var c = await ShopAsync();
        var (first, _, _) = await c.CallAsync("list_findings", new { limit = 2 });
        var total = first.GetProperty("total").GetInt32();
        Assert.True(total > 2);
        var cursor = first.GetProperty("nextCursor").GetString();
        var (second, _, _) = await c.CallAsync("list_findings", new { limit = 2, cursor });
        var ids = first.GetProperty("items").EnumerateArray().Concat(second.GetProperty("items").EnumerateArray()).Select(i => i.GetProperty("id").GetString()).ToList();
        Assert.Equal(4, ids.Distinct().Count());

        var (errors, _, _) = await c.CallAsync("list_findings", new { severity = "error", detail = "full" });
        var captive = Assert.Single(errors.GetProperty("items").EnumerateArray());
        Assert.True(captive.GetProperty("locations").GetArrayLength() >= 2);

        var (cycles, _, _) = await c.CallAsync("list_findings", new { rule = "cycle" });
        Assert.All(cycles.GetProperty("items").EnumerateArray(), i => Assert.StartsWith("cycle.", i.GetProperty("rule").GetString()));
        var (inDomain, _, _) = await c.CallAsync("list_findings", new { within = "Shop.Domain" });
        Assert.All(inDomain.GetProperty("items").EnumerateArray(), i => Assert.Contains(i.GetProperty("nodes").EnumerateArray(), n => n.GetString()!.Contains("Shop.Domain")));
    }

    [Fact]
    public async Task Names_resolve_to_nodes_and_ambiguous_names_list_the_candidates()
    {
        await using var c = await ShopAsync();
        var (described, _, _) = await c.CallAsync("describe_node", new { node = "OrderSummary" });
        Assert.Equal("T:Shop.Application.Orders.OrderSummary", described.GetProperty("node").GetProperty("id").GetString());
        Assert.True(described.TryGetProperty("usedBy", out _));
        Assert.True(described.GetProperty("cycles").GetArrayLength() > 0);

        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App.One { public class Handler { } } namespace App.Two { public class Handler { } }");
        await c.CallAsync("analyze", new { path = ws.Root });
        var (_, text, error) = await c.CallAsync("describe_node", new { node = "Handler" });
        Assert.True(error);
        Assert.Contains("T:App.One.Handler", text);
        Assert.Contains("T:App.Two.Handler", text);
    }

    [Fact]
    public async Task A_dependency_is_explained_by_the_references_behind_it()
    {
        await using var c = await ShopAsync();
        var (json, _, _) = await c.CallAsync("explain_dependency", new { from = "Shop.Application.Pricing", to = "Shop.Application.Orders" });
        Assert.True(json.GetProperty("direct").GetBoolean());
        Assert.True(json.GetProperty("upward").GetBoolean());
        Assert.Equal(2, json.GetProperty("cycle").GetProperty("size").GetInt32());
        var reference = json.GetProperty("references")[0];
        Assert.Equal("src/Shop.Application/Pricing/DiscountPolicies.cs:57", reference.GetProperty("at").GetString());
        Assert.True(json.GetProperty("reverse").GetProperty("weight").GetInt32() > 0);

        var (path, _, _) = await c.CallAsync("explain_dependency", new { from = "OrdersController", to = "Money" });
        Assert.True(path.GetProperty("direct").GetBoolean() || path.GetProperty("paths").GetArrayLength() > 0);
    }

    [Fact]
    public async Task Search_call_flow_diagrams_and_snapshots_work_on_the_map()
    {
        await using var c = await ShopAsync();
        var (search, _, _) = await c.CallAsync("search_nodes", new { level = "member", metric = "complexity", limit = 3 });
        var complexity = search.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("metrics").GetProperty("complexity").GetDouble()).ToList();
        Assert.Equal(complexity.OrderDescending(), complexity);

        var (entries, _, _) = await c.CallAsync("call_flow");
        Assert.Contains(entries.GetProperty("entryPoints").EnumerateArray(), e => e.GetProperty("role").GetString() == "controller");
        var (flow, _, _) = await c.CallAsync("call_flow", new { roots = new[] { "OrdersController" } });
        Assert.StartsWith("sequenceDiagram", flow.GetProperty("flows")[0].GetProperty("mermaid").GetString());

        foreach (var (kind, nodes) in new[] { ("class", new[] { "PlaceOrderHandler" }), ("cycle", new[] { "Shop.Domain.Orders" }), ("layers", Array.Empty<string>()), ("di", Array.Empty<string>()), ("sequence", new[] { "OrdersController" }) })
        {
            var (diagram, text, error) = await c.CallAsync("diagram", new { kind, nodes });
            Assert.False(error, text);
            Assert.False(string.IsNullOrWhiteSpace(diagram.GetProperty("mermaid").GetString()));
        }

        await c.CallAsync("snapshots", new { action = "save", name = "before" });
        var (overview, _, _) = await c.CallAsync("overview", new { graph = "before" });
        Assert.Equal("Shop", overview.GetProperty("map").GetProperty("name").GetString());
        var (list, _, _) = await c.CallAsync("snapshots");
        Assert.Equal("before", list.GetProperty("baselines")[0].GetProperty("name").GetString());
        var (_, missing, error2) = await c.CallAsync("overview", new { graph = "nope" });
        Assert.True(error2);
        Assert.Contains("before", missing);
    }

    [Fact]
    public async Task Long_answers_are_cut_to_the_limit_and_say_so()
    {
        // A synthetic map of 20,000 types, saved as a file the server loads.
        var graph = new CodeGraph { Source = new SourceInfo { Name = "big", Root = Path.GetTempPath(), Path = Path.GetTempPath(), Kind = "directory" } };
        graph.Nodes.Add(new GraphNode { Id = "project:Big", Kind = NodeKinds.Project, Name = "Big", Language = "csharp" });
        graph.Nodes.Add(new GraphNode { Id = "namespace:Big/Big", Kind = NodeKinds.Namespace, Name = "Big", Parent = "project:Big", Project = "project:Big" });
        for (var i = 0; i < 20_000; i++)
        {
            graph.Nodes.Add(new GraphNode { Id = $"T:Big.Type{i}", Kind = NodeKinds.Class, Name = $"Type{i}", FullName = $"Big.Type{i}", Parent = "namespace:Big/Big", Project = "project:Big", Accessibility = "public", Location = new SourceLocation { File = $"Big/Type{i}.cs", Line = 1, EndLine = 10 }, Metrics = new() { ["loc"] = 10 } });
            if (i > 0) graph.Edges.Add(new GraphEdge { Source = $"T:Big.Type{i}", Target = $"T:Big.Type{i - 1}", Kind = EdgeKinds.Uses });
        }

        var file = Path.Combine(Path.GetTempPath(), $"codemap-big-{Guid.NewGuid():N}.codemap.json");
        await using (var stream = File.Create(file)) JsonExporter.Write(graph, stream);
        try
        {
            await using var c = await Connection.OpenAsync(new CodeMapMcpOptions { Analyzer = new AnalyzerOptions { Git = false }, Watch = false, MaxOutput = 6000, Registry = () => LanguageRegistry.BuiltIn });
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var (analysis, _, error) = await c.CallAsync("analyze", new { path = file, waitSeconds = 120 });
            Assert.False(error);
            Assert.Equal(20_000, analysis.GetProperty("stats").GetProperty("types").GetInt32());

            var (search, text, _) = await c.CallAsync("search_nodes", new { query = "Type", limit = 200 });
            Assert.InRange(text.Length, 1000, 6500);
            Assert.Equal(20_000, search.GetProperty("total").GetInt32());
            Assert.Contains("items", search.GetProperty("meta").GetProperty("truncated")[0].GetString());
            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(60), $"took {clock.Elapsed}");
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public async Task A_change_to_the_sources_marks_the_answers_stale()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App; public class A { }");
        await using var c = await Connection.OpenAsync(new CodeMapMcpOptions { Analyzer = new AnalyzerOptions { Git = false }, Watch = true, Registry = () => LanguageRegistry.BuiltIn });
        await c.CallAsync("analyze", new { path = ws.Root });
        var (fresh, _, _) = await c.CallAsync("overview");
        Assert.False(fresh.GetProperty("meta").TryGetProperty("stale", out _));

        ws.File("App/B.cs", "namespace App; public class B { }");
        var (later, _, _) = await c.CallAsync("overview");
        for (var i = 0; i < 50 && !later.GetProperty("meta").TryGetProperty("stale", out _); i++)
        {
            await Task.Delay(100); // the watcher reports the change a moment later
            (later, _, _) = await c.CallAsync("overview");
        }

        Assert.True(later.GetProperty("meta").GetProperty("stale").GetBoolean());
        Assert.Contains("App/B.cs", later.GetProperty("meta").GetProperty("changedFiles").EnumerateArray().Select(f => f.GetString()));

        var (refreshed, _, _) = await c.CallAsync("analyze", new { refresh = true });
        Assert.Equal("done", refreshed.GetProperty("status").GetString());
        Assert.False(refreshed.GetProperty("meta").TryGetProperty("stale", out _));
        Assert.NotNull(c.Session.Previous);
    }

    [Fact]
    public async Task Compare_shows_what_a_refactoring_changed_against_a_baseline()
    {
        using var ws = new TestWorkspace().Project("App");
        const string cycle = """
            namespace App.Orders { public class Order { public App.Customers.Customer? Owner; public void Notify() => Owner!.Tell(); } }
            namespace App.Customers { public class Customer { public void Tell() { } public App.Orders.Order? Last; } }
            """;
        ws.File("App/A.cs", cycle);
        await using var c = await Connection.OpenAsync();
        await c.CallAsync("analyze", new { path = ws.Root });
        await c.CallAsync("snapshots", new { action = "save", name = "before" });
        var (_, sameText, sameError) = await c.CallAsync("compare");
        Assert.True(sameError);
        Assert.Contains("same analysis", sameText);

        ws.File("App/A.cs", cycle.Replace(" public App.Orders.Order? Last;", ""));
        await c.CallAsync("analyze", new { refresh = true });
        var (diff, _, error) = await c.CallAsync("compare");
        Assert.False(error);
        Assert.Equal("before", diff.GetProperty("before").GetProperty("graph").GetString());
        Assert.Contains(diff.GetProperty("findings").GetProperty("resolved").EnumerateArray(), f => f.GetProperty("rule").GetString() == "cycle.namespace");
        var namespaces = diff.GetProperty("cycles").EnumerateArray().Single(x => x.GetProperty("level").GetString() == "namespace");
        Assert.Equal(1, namespaces.GetProperty("resolved").GetArrayLength());
        Assert.True(diff.GetProperty("score").GetProperty("delta").GetInt32() >= 0);
        Assert.Contains(diff.GetProperty("summary").EnumerateArray(), l => l.GetString()!.Contains("namespace cycles: 1 → 0"));

        var (previous, _, _) = await c.CallAsync("compare", new { before = "previous" });
        Assert.True(previous.GetProperty("findings").GetProperty("resolved").GetArrayLength() > 0); // previous is the map before refresh
    }

    [Fact]
    public async Task Simulate_tries_a_refactoring_and_every_tool_reads_the_result()
    {
        await using var c = await ShopAsync();
        var (sim, text, error) = await c.CallAsync("simulate", new { operations = new object[] { new { op = "invertDependency", from = "Shop.Application.Pricing", to = "Shop.Application.Orders" } } });
        Assert.False(error, text);
        Assert.Equal("sim-1", sim.GetProperty("name").GetString());
        Assert.Contains(sim.GetProperty("findings").GetProperty("resolved").EnumerateArray(), f => f.GetProperty("rule").GetString() == "cycle.namespace");
        Assert.Equal("T:Shop.Application.Pricing.IOrderSummary", sim.GetProperty("predictedIds").EnumerateObject().First().Value.GetString());

        var (overview, _, _) = await c.CallAsync("overview", new { graph = "sim-1" });
        Assert.Equal("simulation", overview.GetProperty("meta").GetProperty("graph").GetProperty("origin").GetString());
        var (chained, chainedText, chainedError) = await c.CallAsync("simulate", new { @base = "sim-1", name = "lifetimes", operations = new object[] { new { op = "setLifetime", service = "DailyReportService", lifetime = "scoped" } } });
        Assert.False(chainedError, chainedText);
        Assert.Equal("lifetimes", chained.GetProperty("name").GetString());
        var (list, _, _) = await c.CallAsync("snapshots");
        Assert.Equal(new[] { "sim-1", "lifetimes" }, list.GetProperty("simulations").EnumerateArray().Select(x => x.GetString()));

        var (_, bad, isError) = await c.CallAsync("simulate", new { operations = new object[] { new { op = "moveType", type = "OrderSummary", to = "Nowhere" } } });
        Assert.True(isError);
        Assert.Contains("operations[0].to", bad);
        var operations = await c.Client.ReadResourceAsync("codemap://operations");
        Assert.Contains("invertDependency", ((TextResourceContents)operations.Contents[0]).Text);
    }

    [Fact]
    public async Task Proposals_come_with_operations_that_simulate_takes_as_they_are()
    {
        await using var c = await ShopAsync();
        var (json, text, error) = await c.CallAsync("propose_refactorings", new { limit = 3 });
        Assert.False(error, text);
        var first = json.GetProperty("proposals")[0];
        Assert.Equal("fix-di", first.GetProperty("kind").GetString());
        Assert.Contains(first.GetProperty("predicted").GetProperty("resolves").EnumerateArray(), r => r.GetString()!.StartsWith("di.captive@"));
        Assert.NotEmpty(first.GetProperty("steps").EnumerateArray());

        var operations = first.GetProperty("operations");
        Assert.Equal("setLifetime", operations[0].GetProperty("op").GetString());
        var (simulated, simText, simError) = await c.CallAsync("simulate", new { operations });
        Assert.False(simError, simText);
        Assert.Contains(simulated.GetProperty("findings").GetProperty("resolved").EnumerateArray(), f => f.GetProperty("rule").GetString() == "di.captive");

        var (_, bad, isError) = await c.CallAsync("propose_refactorings", new { finding = "nope@nothing" });
        Assert.True(isError);
        Assert.Contains("No finding", bad);
    }

    [Fact]
    public async Task Nothing_is_written_to_standard_output()
    {
        var original = Console.Out;
        var captured = new StringWriter();
        Console.SetOut(captured);
        try
        {
            await using var c = await ShopAsync();
            await c.CallAsync("overview");
            await c.CallAsync("list_findings");
        }
        finally
        {
            Console.SetOut(original);
        }

        Assert.Equal("", captured.ToString());
    }

    [Fact]
    public async Task Bad_arguments_are_tool_errors_with_a_hint()
    {
        await using var c = await ShopAsync();
        var (_, text, error) = await c.CallAsync("list_findings", new { severity = "fatal" });
        Assert.True(error);
        Assert.Contains("error, warning, info", text);
        (_, text, error) = await c.CallAsync("describe_node");
        Assert.True(error);
        Assert.Contains("'node' is required", text);
    }
}
