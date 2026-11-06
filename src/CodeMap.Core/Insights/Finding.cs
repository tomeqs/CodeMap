using System.Text.Json.Serialization;

namespace CodeMap.Insights;

public static class FindingSeverity
{
    public const string Error = "error";
    public const string Warning = "warning";
    public const string Info = "info";

    public static int Order(string severity) => severity switch { Error => 0, Warning => 1, _ => 2 };
}

public static class FindingCategory
{
    /// <summary>Tangled dependencies: cycles, hubs, god classes, envy, coupling that only git sees.</summary>
    public const string Spaghetti = "spaghetti";

    /// <summary>The shape of the code: layers, stability, sizes, inheritance, modules too small to stand alone.</summary>
    public const string Structure = "structure";

    /// <summary>The dependency injection container.</summary>
    public const string Di = "di";

    public const string DeadCode = "dead-code";

    /// <summary>Checks inside function bodies (compiler warnings and CodeMap's own rules).</summary>
    public const string Code = "code";
}

/// <summary>
/// Something in the structure of the code worth a look, with the evidence: the nodes, the places in the code,
/// the numbers against their thresholds, and what to do about it.
/// </summary>
public sealed class Finding
{
    /// <summary>Stable id, <c>rule@key</c> (the key is the main node, or a pair of them): the same finding has it in every analysis.</summary>
    public required string Id { get; init; }

    public required string Rule { get; init; }

    public required string Category { get; init; }

    /// <summary>error | warning | info</summary>
    public required string Severity { get; init; }

    /// <summary>One line, e.g. "Cycle between 3 namespaces".</summary>
    public required string Title { get; init; }

    /// <summary>What it is and why it matters, with names.</summary>
    public required string Message { get; init; }

    /// <summary>Node ids involved, the main one first.</summary>
    public List<string> Nodes { get; init; } = new();

    /// <summary>Places in the code that show it (at most <see cref="FindingOptions.MaxLocations"/>).</summary>
    public List<FindingLocation> Locations { get; init; } = new();

    /// <summary>The numbers behind it: metrics and the thresholds they crossed (<c>wmc</c>, <c>wmc.limit</c>…).</summary>
    public Dictionary<string, double> Evidence { get; init; } = new(StringComparer.Ordinal);

    /// <summary>Evidence in words, e.g. "OrderService → PaymentGateway: 3 calls (src/Orders/OrderService.cs:42)".</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Facts { get; init; }

    /// <summary>What usually fixes it.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Suggestion { get; init; }

    /// <summary>Kinds of refactoring proposals that can address it (break-cycle, split-type…).</summary>
    public List<string> ProposalKinds { get; init; } = new();

    /// <summary>For ordering: severity times how big the problem is. Higher comes first.</summary>
    public double Rank { get; init; }
}

public sealed class FindingLocation
{
    /// <summary>Path relative to the map's root, with <c>/</c>.</summary>
    public required string File { get; init; }

    public int Line { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int EndLine { get; init; }

    /// <summary>The node the place belongs to.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Node { get; init; }

    /// <summary>What is at that place, e.g. "calls PaymentGateway.Charge".</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Note { get; init; }

    public override string ToString() => Line > 0 ? $"{File}:{Line}" : File;
}

/// <summary>All findings of a map, worst first, with the health score.</summary>
public sealed class FindingsReport
{
    public List<Finding> Findings { get; init; } = new();

    public required HealthScore Score { get; init; }

    /// <summary>Number of findings by severity.</summary>
    public Dictionary<string, int> BySeverity { get; init; } = new(StringComparer.Ordinal);

    /// <summary>Number of findings by category.</summary>
    public Dictionary<string, int> ByCategory { get; init; } = new(StringComparer.Ordinal);

    /// <summary>Number of findings by rule.</summary>
    public Dictionary<string, int> ByRule { get; init; } = new(StringComparer.Ordinal);
}

/// <summary>The thresholds of the rules. The defaults follow the literature (Lanza–Marinescu, Martin) where there is one.</summary>
public sealed class FindingOptions
{
    /// <summary>Also look at test code (test projects, test classes).</summary>
    public bool IncludeTests { get; init; }

    /// <summary>Also look at generated code.</summary>
    public bool IncludeGenerated { get; init; }

    public int MaxLocations { get; init; } = 10;

    /// <summary>A type cycle at least this big is a tangle.</summary>
    public int TangleSize { get; init; } = 8;

    public int HubMinCa { get; init; } = 15;
    public int HubMinCe { get; init; } = 12;

    /// <summary>A hub is also in the top of the codebase for both Ca and Ce (this percentile).</summary>
    public double HubPercentile { get; init; } = 0.95;

    /// <summary>God class: WMC (summed complexity) at least this…</summary>
    public int GodClassWmc { get; init; } = 47;

    /// <summary>…accessing more than this many attributes of other classes…</summary>
    public int GodClassAtfd { get; init; } = 5;

    /// <summary>…with tight class cohesion below this.</summary>
    public double GodClassTcc { get; init; } = 1.0 / 3;

    /// <summary>Feature envy: a method using more than this many attributes of other classes…</summary>
    public int FeatureEnvyAtfd { get; init; } = 2;

    /// <summary>…far more than its own (locality of attribute accesses below this)…</summary>
    public double FeatureEnvyLaa { get; init; } = 1.0 / 3;

    /// <summary>…from at most this many classes.</summary>
    public int FeatureEnvyFdp { get; init; } = 2;

    public int HiddenCouplingMinShared { get; init; } = 3;
    public double HiddenCouplingMinStrength { get; init; } = 0.5;

    /// <summary>A type that changes together with at least this many others (git).</summary>
    public int ShotgunSurgeryPartners { get; init; } = 5;

    /// <summary>A hotspot finding needs at least this many commits (one big rewrite is not a pattern).</summary>
    public int HotspotMinCommits { get; init; } = 3;

    public int LargeTypeLoc { get; init; } = 500;
    public int LargeTypeMembers { get; init; } = 40;
    public int LongMethodLoc { get; init; } = 60;
    public int ComplexMethod { get; init; } = 15;
    public int ManyParameters { get; init; } = 7;

    /// <summary>Inheritance depth within the analyzed code.</summary>
    public int DeepInheritance { get; init; } = 4;

    public int MiddleManMethods { get; init; } = 4;
    public double MiddleManShare { get; init; } = 0.8;

    /// <summary>Stable dependencies: a dependency on something this much less stable (instability).</summary>
    public double SdpMargin { get; init; } = 0.25;

    /// <summary>Containers smaller than this (types) are not judged by the main sequence.</summary>
    public int ZoneMinTypes { get; init; } = 5;

    /// <summary>A constructor asking the container for at least this many services.</summary>
    public int OverInjection { get; init; } = 7;

    /// <summary>A module counts as tiny with at most this many types, when most of its coupling is with one other.</summary>
    public int TinyTypes { get; init; } = 1;
    public double TinyPartnerShare { get; init; } = 0.7;
}
