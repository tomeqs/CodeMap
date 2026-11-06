using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using CodeMap.Export;
using CodeMap.Insights;
using CodeMap.Model;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace CodeMap.Mcp;

/// <summary>A tool: its protocol description and what it does.</summary>
internal sealed record ToolDef(string Name, string Title, string Description, string Schema, Func<ToolCall, CancellationToken, Task<object>> Run)
{
    public Tool Protocol { get; } = new()
    {
        Name = Name,
        Title = Title,
        Description = Description,
        InputSchema = JsonDocument.Parse(Schema).RootElement.Clone(),
        Annotations = new ToolAnnotations { Title = Title, ReadOnlyHint = true, DestructiveHint = false, OpenWorldHint = false },
    };
}

/// <summary>One call of a tool: its arguments, the session, the request (for progress), and how answers are written.</summary>
internal sealed class ToolCall(CodeMapSession session, RequestContext<CallToolRequestParams> request)
{
    private readonly IDictionary<string, JsonElement> _args = request.Params?.Arguments ?? new Dictionary<string, JsonElement>();

    public CodeMapSession Session { get; } = session;
    public RequestContext<CallToolRequestParams> Request { get; } = request;

    /// <summary>An argument as it came (arrays and objects of operations).</summary>
    public JsonElement? Raw(string name) => Arg(name);

    private JsonElement? Arg(string name) =>
        _args.TryGetValue(name, out var value) && value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? value : null;

    public string? String(string name)
    {
        if (Arg(name) is not { } value) return null;
        var text = value.ValueKind == JsonValueKind.String ? value.GetString() : value.GetRawText();
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }

    public string Required(string name) => String(name) ?? throw new ToolException($"'{name}' is required.");

    public bool Bool(string name, bool fallback)
    {
        if (Arg(name) is not { } value) return fallback;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String when bool.TryParse(value.GetString(), out var b) => b,
            _ => throw new ToolException($"'{name}' must be true or false."),
        };
    }

    public int Int(string name, int fallback, int min, int max)
    {
        if (Arg(name) is not { } value) return fallback;
        var number = value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetDouble(out var d) => d,
            JsonValueKind.String when double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
            _ => throw new ToolException($"'{name}' must be a number."),
        };
        return (int)Math.Clamp(Math.Round(number), min, max);
    }

    public double? Number(string name)
    {
        if (Arg(name) is not { } value) return null;
        return value.ValueKind switch
        {
            JsonValueKind.Number => value.GetDouble(),
            JsonValueKind.String when double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
            _ => throw new ToolException($"'{name}' must be a number."),
        };
    }

    /// <summary>An array of strings, or one string (comma separated).</summary>
    public List<string> List(string name)
    {
        if (Arg(name) is not { } value) return new List<string>();
        if (value.ValueKind == JsonValueKind.Array)
            return value.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() : e.GetRawText()).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!.Trim()).ToList();
        return (String(name) ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
    }

    public string Choice(string name, string fallback, params string[] allowed)
    {
        var value = String(name) ?? fallback;
        return allowed.FirstOrDefault(a => a.Equals(value, StringComparison.OrdinalIgnoreCase))
               ?? throw new ToolException($"'{name}' must be one of: {string.Join(", ", allowed)} (got '{value}').");
    }

    /// <summary>Paging: where a list starts (from the cursor) and how many items it shows.</summary>
    public (int Start, int Limit) Page(int fallbackLimit = 20, int maxLimit = 200)
    {
        var limit = Int("limit", fallbackLimit, 1, maxLimit);
        var cursor = String("cursor");
        var start = cursor != null && int.TryParse(cursor, NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) && s >= 0 ? s : 0;
        return (start, limit);
    }

    /// <summary>A node by id, full name, name or the end of a full name; ambiguous names list the candidates.</summary>
    public GraphNode Node(Snapshot snapshot, string query, string? level = null)
    {
        var resolution = snapshot.Index.Resolve(query, level);
        if (resolution.Node != null) return resolution.Node;
        if (resolution.Candidates.Count == 0)
        {
            var near = snapshot.Graph.Nodes.Where(n => !n.External && (n.FullName ?? n.Name).Contains(query, StringComparison.OrdinalIgnoreCase)).Take(10).ToList();
            throw new ToolException($"No node '{query}'{(level != null ? $" at the {level} level" : "")}." + (near.Count > 0 ? $" Similar: {string.Join("; ", near.Select(Describe))}" : " Try search_nodes."));
        }

        throw new ToolException($"'{query}' is ambiguous; use one of these ids: {string.Join("; ", resolution.Candidates.Select(Describe))}");

        static string Describe(GraphNode n) => $"{n.Id} ({n.Kind} {n.FullName ?? n.Name})";
    }
}

/// <summary>How tool answers are written: JSON text plus structured content, a meta block, and a size limit.</summary>
internal static class Answers
{
    public static readonly JsonSerializerOptions Json = new(JsonExporter.Options)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>The state of the analysis an answer is about: when, and whether the code changed since.</summary>
    public static object Meta(CodeMapSession session, Snapshot? snapshot)
    {
        var (changed, count) = session.Changes;
        return new
        {
            graph = snapshot == null ? null : new
            {
                name = snapshot.Name,
                path = snapshot.Path,
                origin = snapshot.Origin,
                analyzedAt = snapshot.At.ToString("u", CultureInfo.InvariantCulture),
            },
            stale = snapshot != null && snapshot == session.Current && count > 0 ? true : (bool?)null,
            changedFiles = snapshot != null && snapshot == session.Current && count > 0 ? changed : null,
            hint = snapshot != null && snapshot == session.Current && count > 0 ? $"{count} change(s) to the sources since this analysis: call analyze with refresh: true for a fresh map." : null,
        };
    }

    public static CallToolResult Result(object payload, object meta, int maxOutput)
    {
        var node = JsonSerializer.SerializeToNode(payload, Json) as JsonObject ?? new JsonObject { ["value"] = JsonSerializer.SerializeToNode(payload, Json) };
        node["meta"] = JsonSerializer.SerializeToNode(meta, Json);
        var truncated = Shrink(node, maxOutput);
        if (truncated.Count > 0) node["meta"]!["truncated"] = new JsonArray(truncated.Select(t => (JsonNode)t).ToArray());
        var text = node.ToJsonString(Json);
        return new CallToolResult
        {
            Content = new List<ContentBlock> { new TextContentBlock { Text = text } },
            StructuredContent = JsonDocument.Parse(text).RootElement.Clone(),
        };
    }

    public static CallToolResult Error(string message) => new()
    {
        IsError = true,
        Content = new List<ContentBlock> { new TextContentBlock { Text = message } },
    };

    /// <summary>
    /// Makes the answer fit: halves the longest list (or cuts the longest text) until it does, and says what was cut.
    /// The meta block is kept.
    /// </summary>
    internal static List<string> Shrink(JsonObject root, int max)
    {
        var cut = new List<string>();
        for (var round = 0; round < 200 && Length(root) > max; round++)
        {
            var (path, target) = Largest(root, "");
            switch (target)
            {
                case JsonArray { Count: > 1 } array:
                    var keep = Math.Max(1, array.Count / 2);
                    var total = array.Count;
                    while (array.Count > keep) array.RemoveAt(array.Count - 1);
                    cut.Add($"{path}: {keep} of {total} items");
                    break;
                case JsonValue value when value.TryGetValue<string>(out var text) && text.Length > 200:
                    var parent = value.Parent;
                    var shorter = text[..(text.Length / 2)] + "… (cut)";
                    if (parent is JsonObject o) o[value.GetPropertyName()] = shorter;
                    else if (parent is JsonArray a) a[value.GetElementIndex()] = shorter;
                    cut.Add($"{path}: text cut to {shorter.Length} characters");
                    break;
                default:
                    return cut;
            }
        }

        return cut.Distinct().ToList();
    }

    private static int Length(JsonNode node) => node.ToJsonString(Json).Length;

    /// <summary>The biggest list or text under a node, by its JSON length (the meta block excluded).</summary>
    private static (string Path, JsonNode? Node) Largest(JsonNode node, string path)
    {
        (string, JsonNode?) best = ("", null);
        var bestLength = 0;
        void Consider(string p, JsonNode? child)
        {
            if (child == null) return;
            var shrinkable = child is JsonArray { Count: > 1 } || child is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 200;
            var length = Length(child);
            if (shrinkable && length > bestLength)
            {
                best = (p, child);
                bestLength = length;
            }

            if (child is JsonObject or JsonArray)
            {
                var inner = Largest(child, p);
                if (inner.Node != null && Length(inner.Node) > bestLength * 0.6 && inner.Node != child)
                {
                    best = inner;
                    bestLength = Length(inner.Node);
                }
            }
        }

        switch (node)
        {
            case JsonObject obj:
                foreach (var (key, child) in obj)
                {
                    if (path.Length == 0 && key == "meta") continue;
                    Consider(path.Length == 0 ? key : $"{path}.{key}", child);
                }

                break;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++) Consider($"{path}[{i}]", array[i]);
                break;
        }

        return best;
    }

    // ------------------------------------------------------------------ shared shapes

    public static string? At(GraphNode node) => node.Location is { } l ? $"{l.File}:{l.Line}" : null;

    public static string? At(SourceLocation? l) => l != null ? $"{l.File}:{l.Line}" : null;

    /// <summary>A node in one line of JSON: id, name, kind, where.</summary>
    public static object Brief(GraphNode node) => new
    {
        id = node.Id,
        name = node.FullName ?? node.Name,
        kind = node.Kind,
        level = NodeLevels.Of(node),
        at = At(node),
    };

    public static object Brief(Finding f) => new
    {
        id = f.Id,
        severity = f.Severity,
        rule = f.Rule,
        title = f.Title,
        message = f.Message,
        at = f.Locations.FirstOrDefault()?.ToString(),
        nodes = f.Nodes.Take(3).ToList(),
    };

    public static object Score(HealthScore score) => new
    {
        score = score.Score,
        grade = score.Grade,
        summary = score.Summary,
        parts = score.Components.Select(c => new { c.Name, c.Penalty, c.Weight, c.Explanation }).ToList(),
    };

    /// <summary>Selected metrics of a node, rounded.</summary>
    public static Dictionary<string, double>? Metrics(GraphNode node, IEnumerable<string>? names = null)
    {
        if (node.Metrics == null) return null;
        var picked = (names == null ? node.Metrics : node.Metrics.Where(m => names.Contains(m.Key)))
            .OrderBy(m => m.Key, StringComparer.Ordinal)
            .ToDictionary(m => m.Key, m => Math.Round(m.Value, 3), StringComparer.Ordinal);
        return picked.Count == 0 ? null : picked;
    }

    public static string? Next(int start, int limit, int total) => start + limit < total ? (start + limit).ToString(CultureInfo.InvariantCulture) : null;
}
