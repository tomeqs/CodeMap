using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap;

/// <summary>Entry point of the library: turns a solution / project / folder into a <see cref="CodeGraph"/>.</summary>
public static class CodeMapAnalyzer
{
    public static CodeGraph Analyze(string path, AnalyzerOptions? options = null, CancellationToken ct = default) =>
        GraphPipeline.Run(path, options, LanguageRegistry.Default, ct);

    /// <summary>The same with a chosen set of languages.</summary>
    public static CodeGraph Analyze(string path, LanguageRegistry languages, AnalyzerOptions? options = null, CancellationToken ct = default) =>
        GraphPipeline.Run(path, options, languages, ct);
}
