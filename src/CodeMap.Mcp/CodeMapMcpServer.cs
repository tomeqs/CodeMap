using System.Text.Json;
using CodeMap.Insights;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace CodeMap.Mcp;

/// <summary>
/// <c>codemap mcp</c>: CodeMap as a Model Context Protocol server, so an AI agent can read the structure of an application
/// (the map, its findings, call flows, diagrams) and use it to improve the code. It only reads; it never edits files.
/// </summary>
public static class CodeMapMcpServer
{
    public const string Instructions = """
        CodeMap maps the structure of C#, TypeScript/JavaScript and Python code: projects, namespaces (folders, packages), types (files, modules), members and
        every dependency between them (calls, inheritance, injection, imports...), with metrics, layers, cycles, DI wiring and git
        history. Use it to understand an application before changing it and to find and fix structural problems.

        Workflow:
        1. analyze - map the code (the server's root, or a path). Large solutions take a while: call analyze again to keep waiting.
        2. overview - the architecture: containers with coupling and layers, the health score, the worst findings.
        3. list_findings - problems with evidence: cycles and their cheapest cut, god classes, hubs, layer violations, DI mistakes,
           dead code... Each finding has ids of the nodes involved, file:line places and a suggestion.
        4. describe_node / explain_dependency / call_flow / diagram / render_map - drill into a node, the references behind a
           dependency (file:line), what an entry point does, draw it as Mermaid, or look at the 3D map as a picture.
        5. propose_refactorings turns findings into concrete refactorings (steps with file:line, cost, simulator operations,
           and, verified by a simulation, what each really fixes).
        6. simulate tries a refactoring on a copy of the map first (move, invert, extract, split, merge, remove; see
           codemap://operations) and shows what it would change; every tool reads the result as graph: "sim-N".
        7. Before refactoring, snapshots {action: save} keeps the current map as a baseline. Edit the code, then
           analyze {refresh: true} and compare: the score, findings resolved and new, cycles, upward dependencies, moves.

        Names: tools take node ids, full names, names or the end of a full name (Orders.OrderService); an ambiguous name returns
        the candidate ids. Lists are paged (limit, cursor). Every answer has a meta block; meta.stale means the sources changed
        since the analysis. Prefer fixing errors and warnings in the spaghetti and structure categories first.
        """;

    /// <summary>
    /// Runs the server over a pair of streams (stdin/stdout for <c>codemap mcp</c>) until the client goes away, or until
    /// <paramref name="ct"/> stops it. A stop returns once the session is closed (the browser of render_map with it),
    /// without waiting for the transport: its input may still be open, and a read of it cannot be interrupted.
    /// </summary>
    public static async Task RunAsync(CodeMapMcpOptions options, Stream input, Stream output, CancellationToken ct)
    {
        using var session = new CodeMapSession(options);
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var closeOnStop = ct.Register(() => Task.Run(() =>
        {
            try { session.Dispose(); }
            catch (Exception ex) { options.Log.WriteLine($"Closing the session: {ex.Message}"); }
            finally { closed.TrySetResult(); }
        }));

        var transport = new StreamServerTransport(input, output, "codemap");
        var server = McpServer.Create(transport, CreateOptions(session));
        if (options.Path != null) session.Start(session.Resolve(options.Path));
        var serving = server.RunAsync(ct);
        await Task.WhenAny(serving, closed.Task).ConfigureAwait(false);
        if (ct.IsCancellationRequested)
        {
            await closed.Task.ConfigureAwait(false);
            return;
        }

        // The client went away (end of input): an orderly end.
        await serving.ConfigureAwait(false);
        await server.DisposeAsync().ConfigureAwait(false);
        await transport.DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>The protocol side: tools, prompts, resources and instructions, all working on one session.</summary>
    internal static McpServerOptions CreateOptions(CodeMapSession session)
    {
        var tools = Tools.All().ToDictionary(t => t.Name, StringComparer.Ordinal);
        return new McpServerOptions
        {
            ServerInfo = new Implementation { Name = "codemap", Title = "CodeMap", Version = session.Options.Version, WebsiteUrl = "https://github.com/tomeqs/CodeMap" },
            ServerInstructions = Instructions,
            Capabilities = new ServerCapabilities
            {
                Tools = new ToolsCapability(),
                Prompts = new PromptsCapability(),
                Resources = new ResourcesCapability(),
            },
            Handlers = new McpServerHandlers
            {
                ListToolsHandler = (_, _) => ValueTask.FromResult(new ListToolsResult { Tools = tools.Values.Select(t => t.Protocol).ToList() }),
                CallToolHandler = async (request, ct) =>
                {
                    var name = request.Params?.Name ?? "";
                    if (!tools.TryGetValue(name, out var tool)) return Answers.Error($"Unknown tool '{name}'. Tools: {string.Join(", ", tools.Keys)}.");
                    var call = new ToolCall(session, request);
                    try
                    {
                        var payload = await tool.Run(call, ct).ConfigureAwait(false);
                        var meta = Answers.Meta(session, CurrentOf(session, call));
                        return payload is ImageAnswer image ? Answers.Image(image, meta) : Answers.Result(payload, meta, session.Options.MaxOutput);
                    }
                    catch (ToolException ex)
                    {
                        return Answers.Error(ex.Message);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                    {
                        session.Options.Log.WriteLine($"{name} failed: {ex}");
                        return Answers.Error($"{name} failed: {ex.GetType().Name}: {ex.Message}");
                    }
                },
                ListPromptsHandler = (_, _) => ValueTask.FromResult(new ListPromptsResult { Prompts = McpPrompts.All.Select(p => p.Prompt).ToList() }),
                GetPromptHandler = (request, _) =>
                {
                    var prompt = McpPrompts.All.FirstOrDefault(p => p.Prompt.Name == request.Params?.Name)
                                 ?? throw new McpException($"Unknown prompt '{request.Params?.Name}'.");
                    var args = request.Params?.Arguments?.ToDictionary(p => p.Key, p => p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? "" : p.Value.GetRawText(), StringComparer.Ordinal)
                               ?? new Dictionary<string, string>(StringComparer.Ordinal);
                    return ValueTask.FromResult(new GetPromptResult
                    {
                        Description = prompt.Prompt.Description,
                        Messages = new List<PromptMessage> { new() { Role = Role.User, Content = new TextContentBlock { Text = prompt.Text(args) } } },
                    });
                },
                ListResourcesHandler = (_, _) => ValueTask.FromResult(new ListResourcesResult { Resources = McpResources.All.Select(r => r.Resource).ToList() }),
                ReadResourceHandler = (request, _) =>
                {
                    var resource = McpResources.All.FirstOrDefault(r => r.Resource.Uri == request.Params?.Uri)
                                   ?? throw new McpException($"Unknown resource '{request.Params?.Uri}'.");
                    return ValueTask.FromResult(new ReadResourceResult
                    {
                        Contents = new List<ResourceContents> { new TextResourceContents { Uri = resource.Resource.Uri, MimeType = resource.Resource.MimeType, Text = resource.Content() } },
                    });
                },
            },
        };
    }

    /// <summary>The graph an answer was about: the one named in its arguments, else the current one.</summary>
    private static Snapshot? CurrentOf(CodeMapSession session, ToolCall call) => session.Find(call.String("graph"));
}

/// <summary>Prompts: ready-made tasks for the agent.</summary>
internal static class McpPrompts
{
    public sealed record Entry(Prompt Prompt, Func<IReadOnlyDictionary<string, string>, string> Text);

    private static string Arg(IReadOnlyDictionary<string, string> args, string name, string fallback) =>
        args.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    public static readonly IReadOnlyList<Entry> All = new Entry[]
    {
        new(new Prompt
            {
                Name = "review_architecture",
                Title = "Review the architecture",
                Description = "Read the map and report the most important structural problems, with evidence and concrete fixes.",
                Arguments = new List<PromptArgument> { new() { Name = "focus", Description = "A project, namespace or type to concentrate on (optional).", Required = false } },
            },
            args => $"""
                Review the architecture of this code with the CodeMap tools{(args.TryGetValue("focus", out var f) && !string.IsNullOrWhiteSpace(f) ? $", concentrating on {f}" : "")}.
                1. Call analyze, then overview (with mermaid: true) to see the containers, layers and the health score.
                2. Call list_findings with severity: warning, then the infos of the spaghetti and structure categories.
                3. For the three to five most important findings, use describe_node, explain_dependency (for cycles and layer
                   violations: the references behind the cut, with file:line) and diagram to confirm them in the code.
                4. Report: the health score and what costs the most; each problem with its evidence (nodes, file:line, numbers) and a
                   concrete, minimal fix (what to move, invert, split or delete); what to do first and why. Do not change any code.
                """),
        new(new Prompt
            {
                Name = "plan_refactoring",
                Title = "Plan a refactoring",
                Description = "Turn findings into a step-by-step refactoring plan that simplifies the structure.",
                Arguments = new List<PromptArgument>
                {
                    new() { Name = "goal", Description = "What to improve, e.g. 'break the cycles in Orders' or a finding id (optional).", Required = false },
                },
            },
            args => $"""
                Plan a refactoring with the CodeMap tools. Goal: {Arg(args, "goal", "the worst structural findings")}.
                1. analyze, then list_findings (detail: full) for the findings that match the goal.
                2. propose_refactorings for them; read the evidence of the best: explain_dependency for the references to cut (file:line),
                   describe_node for the types to split or move, call_flow for the behaviour that must keep working. simulate
                   variations of the proposed operations when the proposal is not quite right.
                3. Save a baseline (snapshots action: save, name: before).
                4. Write a plan of small, safe steps: for each step the files and lines to change, what to move / extract / invert, and
                   which findings it removes. Prefer the cheapest cut of a cycle and dependency inversion over large moves.
                5. After the code is changed, analyze with refresh: true and compare with before: before.
                """),
        new(new Prompt
            {
                Name = "check_changes",
                Title = "Check my changes",
                Description = "After editing code: re-analyze and report what got better or worse against a baseline.",
                Arguments = new List<PromptArgument> { new() { Name = "baseline", Description = "The baseline saved before the changes (default: before).", Required = false } },
            },
            args => $"""
                Check the structural effect of the latest code changes with the CodeMap tools.
                1. analyze with refresh: true.
                2. compare with before: '{Arg(args, "baseline", "before")}' (the current map is the after).
                3. Report the score before and after, findings that disappeared, new findings (with file:line), and new cycles or upward
                   dependencies. If something got worse, say what to change to fix it.
                """),
    };
}

/// <summary>Resources: reference material the agent can read.</summary>
internal static class McpResources
{
    public sealed record Entry(Resource Resource, Func<string> Content);

    public static readonly IReadOnlyList<Entry> All = new Entry[]
    {
        new(new Resource
            {
                Uri = "codemap://rules",
                Name = "rules",
                Title = "Finding rules",
                Description = "Every rule list_findings applies: what it finds, how it decides (thresholds), why it matters, how to fix it.",
                MimeType = "application/json",
            },
            () => JsonSerializer.Serialize(FindingRules.All, Answers.Json)),
        new(new Resource
            {
                Uri = "codemap://operations",
                Name = "operations",
                Title = "Simulation operations",
                Description = "The refactorings the simulate tool can try on a copy of the map, with their fields.",
                MimeType = "text/plain",
            },
            () => Tools.OperationsHelp),
    };
}
