using CodeMap.Analysis;
using CodeMap.Languages;

namespace CodeMap.Mcp;

/// <summary>How <c>codemap mcp</c> runs.</summary>
public sealed class CodeMapMcpOptions
{
    /// <summary>What to analyze as soon as the server starts (a folder, solution, project or .codemap.json); null waits for the agent.</summary>
    public string? Path { get; init; }

    /// <summary>The folder relative paths are resolved against; null: the client's first root, else the current directory.</summary>
    public string? Root { get; init; }

    /// <summary>Watch the analyzed folder and mark the analysis stale when sources change.</summary>
    public bool Watch { get; init; } = true;

    /// <summary>Options of every analysis (git, tests, generated code…); agents get the checks inside function bodies too.</summary>
    public AnalyzerOptions Analyzer { get; init; } = new() { CodeChecks = true };

    /// <summary>The languages: C# and the plugins found.</summary>
    public Func<LanguageRegistry> Registry { get; init; } = () => LanguageRegistry.Default;

    /// <summary>The most characters a tool answer may have; longer answers are shortened and marked truncated.</summary>
    public int MaxOutput { get; init; } = 30_000;

    /// <summary>Where the server writes what it does (stderr: stdout is the protocol).</summary>
    public TextWriter Log { get; init; } = TextWriter.Null;

    public string Version { get; init; } = typeof(CodeMapMcpOptions).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
}
