using System.Text.Json.Serialization;

namespace CodeMap.Model;

/// <summary>
/// Root of the CodeMap graph format (see docs/format.md).
/// Nodes form a containment tree through <see cref="GraphNode.Parent"/>;
/// edges describe every other relationship between them.
/// </summary>
public sealed class CodeGraph
{
    public const string FormatName = "codemap";
    public const string FormatVersion = "1.0";

    public string Format { get; set; } = FormatName;
    public string Version { get; set; } = FormatVersion;
    public GeneratorInfo Generator { get; set; } = new();
    public DateTimeOffset GeneratedAt { get; set; } = DateTimeOffset.UtcNow;
    public SourceInfo Source { get; set; } = new();
    public Dictionary<string, int> Stats { get; set; } = new();
    public List<GraphNode> Nodes { get; set; } = new();
    public List<GraphEdge> Edges { get; set; } = new();
    public AnalysisResult Analysis { get; set; } = new();
}

public sealed class GeneratorInfo
{
    public string Name { get; set; } = "codemap";
    public string Version { get; set; } = typeof(CodeGraph).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
}

public sealed class SourceInfo
{
    /// <summary>Absolute path of the analyzed solution, project or directory.</summary>
    public string Path { get; set; } = "";

    /// <summary>Absolute directory that all <see cref="SourceLocation.File"/> paths are relative to.</summary>
    public string Root { get; set; } = "";

    /// <summary>solution | project | directory</summary>
    public string Kind { get; set; } = "";

    public string Name { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public GitInfo? Git { get; set; }
}

public sealed class GitInfo
{
    public string? Branch { get; set; }
    public string? Commit { get; set; }
    public int CommitsAnalyzed { get; set; }
    public string? Since { get; set; }
}

public sealed class GraphNode
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Name { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FullName { get; set; }

    /// <summary>Containing node (project, namespace or type). Null for top-level nodes.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Parent { get; set; }

    /// <summary>Id of the project node that declares this node.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Project { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Namespace { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Accessibility { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Modifiers { get; set; }

    /// <summary>Human readable declaration, e.g. <c>Task&lt;Order&gt; PlaceAsync(Cart cart)</c>.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Signature { get; set; }

    /// <summary>Base class display name (also set for external base classes).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? BaseType { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SourceLocation? Location { get; set; }

    /// <summary>Additional declarations of partial types.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<SourceLocation>? ExtraLocations { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Attributes { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Tags { get; set; }

    /// <summary>First sentence-ish of the XML documentation summary.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Doc { get; set; }

    /// <summary>True for symbols that live outside the analyzed code (BCL, NuGet packages).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool External { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, double>? Metrics { get; set; }

    public void AddTag(string tag)
    {
        Tags ??= new List<string>();
        if (!Tags.Contains(tag)) Tags.Add(tag);
    }

    public bool HasTag(string tag) => Tags?.Contains(tag) == true;

    public void SetMetric(string name, double value)
    {
        Metrics ??= new Dictionary<string, double>();
        Metrics[name] = value;
    }

    public double Metric(string name) => Metrics != null && Metrics.TryGetValue(name, out var v) ? v : 0;

    public override string ToString() => $"{Kind} {Id}";
}

public sealed class SourceLocation
{
    /// <summary>Path relative to <see cref="SourceInfo.Root"/>, always with forward slashes.</summary>
    public string File { get; set; } = "";
    public int Line { get; set; }
    public int EndLine { get; set; }
}

public sealed class GraphEdge
{
    public string Source { get; set; } = "";
    public string Target { get; set; } = "";
    public string Kind { get; set; } = "";

    /// <summary>How many times the relationship occurs in code (e.g. number of call sites).</summary>
    public int Weight { get; set; } = 1;

    public override string ToString() => $"{Source} -{Kind}-> {Target}";
}

public sealed class AnalysisResult
{
    public List<CycleInfo> Cycles { get; set; } = new();
    public List<RankedItem> Hotspots { get; set; } = new();
    public List<RankedItem> MostComplex { get; set; } = new();
    public List<RankedItem> MostDepended { get; set; } = new();
    public List<string> UnusedCandidates { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
}

public sealed class CycleInfo
{
    /// <summary>project | namespace | type</summary>
    public string Level { get; set; } = "";
    public List<string> Nodes { get; set; } = new();
}

public sealed class RankedItem
{
    public string Id { get; set; } = "";
    public double Score { get; set; }
}
