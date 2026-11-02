using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Languages;

/// <summary>
/// A language CodeMap can map. It reads the code and returns the raw graph; everything that does not depend on
/// the language – metrics, cycles, unused code, layers, DI checks, git history, merging languages into one map –
/// is done afterwards by <see cref="Pipeline.GraphPipeline"/>, the same way for all of them.
/// </summary>
public interface ILanguageAnalyzer
{
    LanguageInfo Info { get; }

    /// <summary>Whether this file can be analyzed on its own (a solution, a project file, a source file…).</summary>
    bool CanAnalyzeFile(string path);

    /// <summary>Whether a folder or its subfolders hold code in this language.</summary>
    bool Detect(string directory, CancellationToken ct);

    /// <summary>
    /// The raw graph of a file or folder:
    /// <list type="bullet">
    /// <item>nodes in a tree through <c>parent</c> (project → namespace → type → member), each with its <c>project</c>;</item>
    /// <item>edges (dependencies of the source on the target), with the line of the first call for calls;</item>
    /// <item>locations relative to <c>source.root</c>, with <c>/</c>; <c>loc</c> and <c>complexity</c> metrics, tags;</item>
    /// <item><c>source</c> and <c>analysis.warnings</c>;</item>
    /// <item>in <c>analysis.di</c> the container registrations and, for every type, the services its constructor asks
    /// for (consumer, service, external, many, optional); lifetimes, implementations and issues are worked out later.</item>
    /// </list>
    /// Other metrics, cycles, layers, unused code and git data are left to the pipeline.
    /// </summary>
    CodeGraph Analyze(string path, AnalyzerOptions options, CancellationToken ct);

    /// <summary>Project files directly in a folder, for the folder browser: their names and what they are (solution, project).</summary>
    IEnumerable<(string File, string Kind)> MarkersIn(string directory) => Array.Empty<(string, string)>();

    /// <summary>Whether a change to this file can change the map (live updates).</summary>
    bool IsWatched(string path) => false;

    /// <summary>Folders with no code of the language (build output, dependencies): not browsed, not watched.</summary>
    IReadOnlyCollection<string> IgnoredFolders => Array.Empty<string>();

    /// <summary>Why the language cannot be analyzed on this computer (a missing runtime), or null.</summary>
    string? Unavailable => null;
}

/// <summary>What the pipeline and the messages need to know about a language.</summary>
public sealed class LanguageInfo
{
    /// <summary>Stable identifier, e.g. "csharp".</summary>
    public required string Id { get; init; }

    /// <summary>Display name, e.g. "C#".</summary>
    public required string Name { get; init; }

    /// <summary>Files that can be passed in, for messages: "a .sln, .slnx, .slnf, .csproj, .cs file".</summary>
    public required string Inputs { get; init; }

    /// <summary>The same as file name patterns ("*.sln", "package.json"), for the app's path box.</summary>
    public IReadOnlyList<string> InputPatterns { get; init; } = Array.Empty<string>();

    /// <summary>What a folder needs to contain, for messages: ".csproj or .cs files".</summary>
    public required string Markers { get; init; }

    /// <summary>What the language's maps call each level (C#'s words unless given).</summary>
    public LevelLabels Levels { get; init; } = new();

    /// <summary>What code outside the analyzed sources is called, e.g. "BCL / NuGet", "npm packages".</summary>
    public string External { get; init; } = "external";

    /// <summary>Which declarations may be reported as unused.</summary>
    public UnusedPolicy Unused { get; init; } = UnusedPolicy.None;

    public LanguageSummary Summary() => new() { Id = Id, Name = Name, Levels = Levels, External = External };
}
