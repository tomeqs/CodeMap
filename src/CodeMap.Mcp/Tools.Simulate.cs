using System.Text.Json;
using CodeMap.Insights;
using CodeMap.Model;

namespace CodeMap.Mcp;

internal static partial class Tools
{
    /// <summary>The operations simulate takes (the resource codemap://operations).</summary>
    public const string OperationsHelp = """
        Operations of the simulate tool. Every node can be an id, a full name or a name; the batch is applied as a whole or not
        at all. Ids of existing nodes never change; new nodes get the id the real code would most likely give them (C#), else a
        sim: id, and the tag "simulated".

        {"op":"moveType","type":"<type>","to":"<namespace>"}
            Move a type (a file in TypeScript, a module in Python) with its members into another namespace (folder, package).
        {"op":"moveMember","member":"<member>","to":"<type or class>"}
            Move a method, property or field to another type: e.g. the fix for feature envy.
        {"op":"moveNamespace","namespace":"<namespace>","toProject":"<project>"}
            Move a namespace with everything in it to another project (package).
        {"op":"mergeNamespaces","from":"<namespace>","into":"<namespace>"}
            Move everything in one namespace into another and drop the first: the fix for tiny namespaces.
        {"op":"removeDependency","from":"<node>","to":"<node>","kinds":["calls","uses"]}
            Drop the references from everything in one node to everything in another (optionally only some edge kinds):
            what cutting a dependency would do, however it is cut.
        {"op":"invertDependency","from":"<node>","to":"<node>","interfaceIn":"<namespace>"}
            Dependency inversion: an interface for each type of 'to' that 'from' uses, placed in interfaceIn (default: beside
            the first user), implemented by that type; 'from' then uses the interfaces and the DI container injects the
            types for them. Inheritance cannot be inverted and is left as it is.
        {"op":"extractInterface","type":"<type>","name":"IName","members":["Save","Load"],"in":"<namespace>"}
            An interface with members of a type (default: those used from outside it); users outside the type use it.
        {"op":"splitType","type":"<type>","parts":[{"name":"OrderPricing","members":["Price","Discount"]}]}
            New types beside a type, each taking the listed members; the rest stays.
        {"op":"removeNode","node":"<node>"}
            Remove a node with everything in it and every reference to it (dead code).
        {"op":"setLifetime","service":"<service or implementation>","lifetime":"singleton|scoped|transient"}
            Give the DI registrations another lifetime: the fix for captive dependencies.
        """;

    private static readonly ToolDef Simulate = new("simulate", "What-if simulation",
        "Tries refactorings on a copy of the map, without touching code: move types, members or namespaces, merge namespaces, " +
        "remove or invert dependencies, extract interfaces, split types, remove dead code, change DI lifetimes. Returns the " +
        "simulated map's name (sim-N, usable as graph in every tool) and what it changes against the base: the score, findings " +
        "resolved and new, cycles and upward dependencies. The operations are described in codemap://operations.",
        """
        {"type":"object","required":["operations"],"properties":{
          "operations":{"type":"array","description":"Operations applied in order, as one batch: [{\"op\":\"moveType\",\"type\":\"...\",\"to\":\"...\"}, ...]. See codemap://operations.","items":{"type":"object","required":["op"],"properties":{"op":{"type":"string","enum":["moveType","moveMember","moveNamespace","mergeNamespaces","removeDependency","invertDependency","extractInterface","splitType","removeNode","setLifetime"]}}}},
          "base":{"type":"string","description":"The graph to start from: current (default), a baseline, or an earlier simulation (sim-N) to build on."},
          "name":{"type":"string","description":"Keep the result under this name instead of sim-N."},
          "limit":{"type":"number","description":"Items per list in the comparison (default 15)."}
        }}
        """,
        async (call, ct) =>
        {
            var session = call.Session;
            var baseRef = call.String("base");
            var start = await session.GraphAsync(baseRef, ct).ConfigureAwait(false);
            var operations = ParseOperations(call, start);
            SimulationResult result;
            try
            {
                result = await Task.Run(() => Simulator.Run(start.Raw, operations, gitFrom: start.Graph), ct).ConfigureAwait(false);
            }
            catch (SimulationException ex)
            {
                throw new ToolException($"Nothing was simulated: {ex.Message}");
            }

            var snapshot = new Snapshot(start.Name, start.Path, result.Raw, result.Graph, "simulation", 0);
            var name = session.AddSimulation(snapshot, call.String("name"));
            var limit = call.Int("limit", 15, 1, 100);
            var diff = GraphDiff.Compare(start.Index, start.Findings, snapshot.Index, snapshot.Findings, NodeLevels.Namespace, limit);
            string Name(string id) => snapshot.Index.Node(id)?.FullName ?? snapshot.Index.Node(id)?.Name ?? start.Index.Node(id)?.FullName ?? id;
            return new
            {
                name,
                @base = baseRef ?? "current",
                applied = result.Applied,
                notes = result.Notes.Count > 0 ? result.Notes : null,
                predictedIds = result.PredictedIds.Count > 0 ? result.PredictedIds : null,
                summary = diff.Summary,
                score = diff.Score,
                findings = new { resolved = diff.Findings.Resolved.Select(Answers.Brief).ToList(), added = diff.Findings.Added.Select(Answers.Brief).ToList(), deltaBySeverity = diff.Findings.DeltaBySeverity },
                cycles = diff.Cycles.Where(c => c.Before != c.After || c.Resolved.Count + c.Added.Count > 0).Select(c => new { c.Level, c.Before, c.After }).ToList(),
                upward = new { diff.Upward.Before, diff.Upward.After, resolved = diff.Upward.Resolved.Select(d => $"{Name(d.Source)} → {Name(d.Target)}").ToList(), added = diff.Upward.Added.Select(d => $"{Name(d.Source)} → {Name(d.Target)}").ToList() },
                next = $"Every tool takes graph: \"{name}\" (overview, list_findings, diagram…); simulate with base: \"{name}\" builds on it; compare before: \"{baseRef ?? "current"}\" after: \"{name}\" for the full comparison.",
            };
        });

    /// <summary>The operations of a call, with every node resolved; a problem names the operation and the field.</summary>
    private static List<SimOp> ParseOperations(ToolCall call, Snapshot start)
    {
        var raw = call.Raw("operations");
        if (raw is not { ValueKind: JsonValueKind.Array } array || array.GetArrayLength() == 0) throw new ToolException("'operations' must be a non-empty array of {\"op\": …} objects (see codemap://operations).");
        var result = new List<SimOp>();
        var i = 0;
        foreach (var item in array.EnumerateArray())
        {
            i++;
            string Where(string field) => $"operations[{i - 1}].{field}";
            if (item.ValueKind != JsonValueKind.Object) throw new ToolException($"operations[{i - 1}] must be an object.");
            string? Text(string field) => item.TryGetProperty(field, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;
            string Need(string field) => Text(field) ?? throw new ToolException($"{Where(field)} is required.");
            List<string> Texts(string field) => item.TryGetProperty(field, out var v) && v.ValueKind == JsonValueKind.Array
                ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList()
                : new List<string>();
            string Id(string field, string? level = null)
            {
                try
                {
                    return call.Node(start, Need(field), level).Id;
                }
                catch (ToolException ex)
                {
                    throw new ToolException($"{Where(field)}: {ex.Message}");
                }
            }

            string? OptionalId(string field, string? level = null) => Text(field) != null ? Id(field, level) : null;
            var op = Need("op");
            result.Add(op switch
            {
                "moveType" => new MoveTypeOp(Id("type"), Id("to", NodeLevels.Namespace)),
                "moveMember" => new MoveMemberOp(Id("member", NodeLevels.Member), Id("to")),
                "moveNamespace" => new MoveNamespaceOp(Id("namespace", NodeLevels.Namespace), Id("toProject", NodeLevels.Project)),
                "mergeNamespaces" => new MergeNamespacesOp(Id("from", NodeLevels.Namespace), Id("into", NodeLevels.Namespace)),
                "removeDependency" => new RemoveDependencyOp(Id("from"), Id("to"), Texts("kinds")),
                "invertDependency" => new InvertDependencyOp(Id("from"), Id("to"), OptionalId("interfaceIn")),
                "extractInterface" => new ExtractInterfaceOp(Id("type"), Text("name"), Texts("members") is { Count: > 0 } members ? members : null, OptionalId("in")),
                "splitType" => new SplitTypeOp(Id("type"), Parts(item, Where("parts"))),
                "removeNode" => new RemoveNodeOp(Id("node")),
                "setLifetime" => new SetLifetimeOp(Id("service"), Need("lifetime").ToLowerInvariant()),
                _ => throw new ToolException($"{Where("op")}: unknown operation '{op}' (see codemap://operations)."),
            });
        }

        return result;
    }

    private static List<SplitPart> Parts(JsonElement item, string where)
    {
        if (!item.TryGetProperty("parts", out var parts) || parts.ValueKind != JsonValueKind.Array || parts.GetArrayLength() == 0)
            throw new ToolException($"{where} must be an array of {{\"name\": …, \"members\": […]}}.");
        return parts.EnumerateArray().Select(p => new SplitPart(
            p.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : throw new ToolException($"{where}: every part needs a name."),
            p.TryGetProperty("members", out var m) && m.ValueKind == JsonValueKind.Array ? m.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList() : throw new ToolException($"{where}: every part needs members."))).ToList();
    }
}
