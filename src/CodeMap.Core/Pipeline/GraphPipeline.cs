using System.Diagnostics;
using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>
/// One analysis from start to finish: picks the languages for the input, lets each of them read its code,
/// merges what they found into one graph and derives everything that does not depend on the language.
/// </summary>
public static class GraphPipeline
{
    public static CodeGraph Run(string path, AnalyzerOptions? options, LanguageRegistry registry, CancellationToken ct = default)
    {
        options ??= new AnalyzerOptions();
        var log = options.Log ?? (_ => { });
        var stopwatch = Stopwatch.StartNew();

        var languages = Select(path, registry, ct);
        var fragments = new List<(ILanguageAnalyzer Language, CodeGraph Graph)>();
        var failures = new List<string>();
        foreach (var language in languages)
        {
            ct.ThrowIfCancellationRequested();
            if (languages.Count == 1)
            {
                fragments.Add((language, language.Analyze(path, options, ct)));
                continue;
            }

            // In a folder with several languages, one that fails leaves the others' map.
            try
            {
                fragments.Add((language, language.Analyze(path, options, ct)));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failures.Add($"{language.Info.Name} was not analyzed: {ex.Message}");
                log($"{language.Info.Name} was not analyzed: {ex.Message}");
            }
        }

        if (fragments.Count == 0) throw new InvalidOperationException(string.Join(Environment.NewLine, failures));

        foreach (var (language, fragment) in fragments)
        {
            foreach (var node in fragment.Nodes.Where(n => n.Kind is NodeKinds.Project or NodeKinds.Package)) node.Language ??= language.Info.Id;
        }

        var graph = fragments.Count == 1 ? fragments[0].Graph : GraphMerger.Merge(Path.GetFullPath(path), fragments.Select(f => f.Graph).ToList());
        graph.Analysis.Warnings.AddRange(failures);
        graph.Source.Languages = fragments.Select(f => f.Language.Info.Summary()).ToList();

        var languageOfProject = new Dictionary<string, LanguageInfo>(StringComparer.Ordinal);
        foreach (var (language, fragment) in fragments)
        {
            foreach (var node in fragment.Nodes.Where(n => n.Kind == NodeKinds.Project)) languageOfProject.TryAdd(node.Id, language.Info);
        }

        GraphMetrics.Compute(graph, node => node.Project != null && languageOfProject.TryGetValue(node.Project, out var language) ? language.Unused : null);
        Layering.Analyze(graph);
        DependencyInjectionAnalysis.Compute(graph);
        if (options.Git) GitEnrichment.Apply(graph, options, log);
        graph.Stats = GraphStats.Compute(graph);

        log($"Analysis finished in {stopwatch.Elapsed.TotalSeconds:0.0}s: {graph.Nodes.Count} nodes, {graph.Edges.Count} edges");
        return graph;
    }

    /// <summary>The language that takes a file, or every language found in a folder.</summary>
    private static List<ILanguageAnalyzer> Select(string path, LanguageRegistry registry, CancellationToken ct)
    {
        var full = Path.GetFullPath(path);
        if (File.Exists(full))
        {
            var language = registry.Languages.FirstOrDefault(l => l.CanAnalyzeFile(full));
            if (language != null) return new List<ILanguageAnalyzer> { language };
            throw new ArgumentException($"Unsupported input '{path}'. Use {string.Join(", ", registry.Languages.Select(l => l.Info.Inputs))} or a directory.");
        }

        if (Directory.Exists(full))
        {
            var found = registry.Languages.Where(l => l.Detect(full, ct)).ToList();
            if (found.Count > 0) return found;
            throw new ArgumentException($"No {string.Join(" or ", registry.Languages.Select(l => l.Info.Markers))} found in '{path}'.");
        }

        throw new FileNotFoundException($"Input '{path}' does not exist.");
    }
}
