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

    /// <summary>What a folder needs to contain, for messages: ".csproj or .cs files".</summary>
    public required string Markers { get; init; }

    /// <summary>Which declarations may be reported as unused.</summary>
    public UnusedPolicy Unused { get; init; } = UnusedPolicy.None;
}
