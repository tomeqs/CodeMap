using System.Text.RegularExpressions;

namespace CodeMap.Languages;

/// <summary>
/// Which declarations of a language may be reported as unused (nothing in the graph points at them), and which
/// are reached in ways the graph does not show: by the runtime, a framework, reflection or a naming convention.
/// The detection itself is the same for every language.
/// </summary>
public sealed class UnusedPolicy
{
    private static readonly IReadOnlySet<string> Nothing = new HashSet<string>();

    /// <summary>No unused-code detection.</summary>
    public static readonly UnusedPolicy None = new() { Enabled = false };

    public bool Enabled { get; init; } = true;

    /// <summary>Accessibility a member needs to be a candidate (others may be used from outside); null = any.</summary>
    public IReadOnlySet<string>? MemberAccessibility { get; init; }

    /// <summary>Accessibility a type needs to be a candidate; null = any.</summary>
    public IReadOnlySet<string>? TypeAccessibility { get; init; }

    /// <summary>Skip declarations with attributes / decorators: frameworks find them.</summary>
    public bool SkipAttributed { get; init; } = true;

    /// <summary>Tags that keep a type or member out (entry points, tests…).</summary>
    public IReadOnlySet<string> SkipTags { get; init; } = Nothing;

    public IReadOnlySet<string> SkipMemberKinds { get; init; } = Nothing;
    public IReadOnlySet<string> SkipModifiers { get; init; } = Nothing;

    /// <summary>Member names that are called by convention (Dispose, ToString…).</summary>
    public IReadOnlySet<string> SkipNames { get; init; } = Nothing;

    public Regex? SkipNamePattern { get; init; }

    /// <summary>Members of these kinds of parents are skipped (interface members are reached through the contract).</summary>
    public IReadOnlySet<string> SkipParentKinds { get; init; } = Nothing;

    public IReadOnlySet<string> SkipParentTags { get; init; } = Nothing;

    /// <summary>Types the framework creates by itself (controllers, hosted services…).</summary>
    public IReadOnlySet<string> SkipTypeTags { get; init; } = Nothing;
}
