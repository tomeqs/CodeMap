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
    public const string FormatVersion = "1.1";

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

    /// <summary>Languages found in the source, with the words their maps use for each level.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<LanguageSummary>? Languages { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public GitInfo? Git { get; set; }
}

public sealed class LanguageSummary
{
    /// <summary>Stable identifier, e.g. "csharp", "typescript".</summary>
    public string Id { get; set; } = "";

    public string Name { get; set; } = "";

    public LevelLabels Levels { get; set; } = new();

    /// <summary>What code outside the analyzed sources is called, e.g. "BCL / NuGet".</summary>
    public string External { get; set; } = "";
}

/// <summary>What a language calls each level of the map: [singular, plural].</summary>
public sealed class LevelLabels
{
    public List<string> Project { get; set; } = new() { "Project", "Projects" };
    public List<string> Namespace { get; set; } = new() { "Namespace", "Namespaces" };
    public List<string> Type { get; set; } = new() { "Type", "Types" };
    public List<string> Member { get; set; } = new() { "Member", "Members" };
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

    /// <summary>
    /// project | namespace | type | member: where the node sits on the map. Optional for the kinds whose level is
    /// known (C#'s); set by other languages, whose kinds can sit at different levels (a TypeScript class is a member
    /// of its file).
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Level { get; set; }

    public string Name { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FullName { get; set; }

    /// <summary>Containing node (project, namespace or type). Null for top-level nodes.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Parent { get; set; }

    /// <summary>Id of the project node that declares this node.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Project { get; set; }

    /// <summary>Language of a project or package node (an id from <see cref="SourceInfo.Languages"/>).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Language { get; set; }

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

    /// <summary>Calls and instantiations: line of the first occurrence in the source member's file (gives the call order).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int Line { get; set; }

    public override string ToString() => $"{Source} -{Kind}-> {Target}";
}

public sealed class AnalysisResult
{
    public List<CycleInfo> Cycles { get; set; } = new();
    public List<RankedItem> Hotspots { get; set; } = new();
    public List<RankedItem> MostComplex { get; set; } = new();
    public List<RankedItem> MostDepended { get; set; } = new();
    public List<string> UnusedCandidates { get; set; } = new();

    /// <summary>Automatic layering per level: dependencies point down, "upward" ones work against the architecture.</summary>
    public List<LayeringInfo> Layers { get; set; } = new();

    /// <summary>Types that change in the same commits (git), strongest first.</summary>
    public List<ChangeCouplingInfo> ChangeCoupling { get; set; } = new();

    /// <summary>Dependency-injection container setup found in code; null when nothing was registered.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DiAnalysis? Di { get; set; }

    public List<string> Warnings { get; set; } = new();
}

public sealed class LayeringInfo
{
    /// <summary>project | namespace | type</summary>
    public string Level { get; set; } = "";

    /// <summary>Layers from the bottom (depends on nothing) to the top; each is a list of node ids.</summary>
    public List<List<string>> Layers { get; set; } = new();

    /// <summary>Dependencies that point up (against the layering); breaking them removes all cycles.</summary>
    public List<GraphEdge> Upward { get; set; } = new();
}

public sealed class ChangeCouplingInfo
{
    public string Source { get; set; } = "";
    public string Target { get; set; } = "";

    /// <summary>Commits that touched both.</summary>
    public int SharedCommits { get; set; }

    /// <summary>Shared commits relative to the average number of commits of the two (0..1).</summary>
    public double Strength { get; set; }

    /// <summary>True when there is no code dependency between the two in either direction.</summary>
    public bool Hidden { get; set; }
}

public sealed class DiAnalysis
{
    public List<ServiceRegistration> Registrations { get; set; } = new();
    public List<DiDependency> Dependencies { get; set; } = new();
    public List<DiIssue> Issues { get; set; } = new();
}

public sealed class ServiceRegistration
{
    /// <summary>Node id of the service type (interface or class), or its full name when it is a framework type.</summary>
    public string Service { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool External { get; set; }

    /// <summary>Node id of the implementation; null for factories we cannot see through.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Implementation { get; set; }

    /// <summary>singleton | scoped | transient</summary>
    public string Lifetime { get; set; } = "";

    /// <summary>The lifetime the framework ends up giving it, when that differs (NestJS: request scope spreads to consumers).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Effective { get; set; }

    /// <summary>type | instance | factory | forward | hosted | dbcontext | httpclient | controller | component</summary>
    public string Kind { get; set; } = "type";

    /// <summary>DI container: microsoft (when left out), nest, angular…; decides which rules apply.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Framework { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Key { get; set; }

    /// <summary>Member that performs the registration (e.g. AddInfrastructure).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RegisteredIn { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SourceLocation? Location { get; set; }
}

/// <summary>"consumer needs service" resolved to the registered implementation(s).</summary>
public sealed class DiDependency
{
    /// <summary>Type whose constructor asks for the service.</summary>
    public string Consumer { get; set; } = "";

    /// <summary>Lifetime of the consumer: singleton | scoped | transient (framework-activated types count as transient).</summary>
    public string ConsumerLifetime { get; set; } = "";

    /// <summary>Requested service: node id for code in the solution, otherwise the type's full name.</summary>
    public string Service { get; set; } = "";

    public bool External { get; set; }

    /// <summary>IEnumerable&lt;T&gt;: every registration is injected.</summary>
    public bool Many { get; set; }

    public bool Optional { get; set; }

    /// <summary>Implementations the container would inject (empty when the service is not registered).</summary>
    public List<string> Implementations { get; set; } = new();

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Lifetime { get; set; }

    /// <summary>DI container (left out for microsoft); for raw dependencies, the consumer's registration decides when missing.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Framework { get; set; }
}

public sealed class DiIssue
{
    /// <summary>captive | captive-transient | unregistered | scope-bubbling | interface-injection | unreachable</summary>
    public string Kind { get; set; } = "";

    /// <summary>error | warning | info</summary>
    public string Severity { get; set; } = "";

    public string Consumer { get; set; } = "";
    public string Service { get; set; } = "";
    public string Message { get; set; } = "";
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
