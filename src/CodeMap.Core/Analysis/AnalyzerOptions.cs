namespace CodeMap.Analysis;

public sealed class AnalyzerOptions
{
    /// <summary>Also emit nodes for framework / NuGet types that the code depends on (type level only).</summary>
    public bool IncludeExternal { get; set; }

    /// <summary>Analyze generated files (*.g.cs, *.Designer.cs, files marked &lt;auto-generated&gt;).</summary>
    public bool IncludeGenerated { get; set; }

    /// <summary>Analyze test projects.</summary>
    public bool IncludeTests { get; set; } = true;

    /// <summary>Read git history to compute churn / hotspot metrics.</summary>
    public bool Git { get; set; } = true;

    /// <summary>Passed to <c>git log --since</c>, e.g. "1 year ago". Null means the whole history.</summary>
    public string? GitSince { get; set; }

    public int GitMaxCommits { get; set; } = 20000;

    /// <summary>
    /// Check the code inside function bodies too: selected compiler warnings and CodeMap's own rules (swallowed
    /// exceptions, sync over async, floating promises…), in <see cref="Model.AnalysisResult.Diagnostics"/>.
    /// </summary>
    public bool CodeChecks { get; set; }

    public Action<string>? Log { get; set; }
}
