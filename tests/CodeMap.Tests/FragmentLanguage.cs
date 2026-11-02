using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// A stand-in for a TypeScript analyzer: returns a raw graph written by hand (*.fragment.json), so the shared
/// analysis and the viewer can be tested on a TypeScript-shaped map: files as units, classes and functions inside.
/// </summary>
internal sealed class FragmentLanguage : ILanguageAnalyzer
{
    public LanguageInfo Info { get; } = new()
    {
        Id = "typescript",
        Name = "TypeScript",
        Inputs = "a .fragment.json file",
        Markers = ".fragment.json files",
        Levels = new LevelLabels
        {
            Project = new() { "Package", "Packages" },
            Namespace = new() { "Folder", "Folders" },
            Type = new() { "File", "Files" },
            Member = new() { "Declaration", "Declarations" },
        },
        External = "npm packages",
        Unused = new UnusedPolicy
        {
            MemberAccessibility = new HashSet<string> { "private" },
            SkipTags = new HashSet<string> { Tags.EntryPoint, Tags.Test },
            SkipMemberKinds = new HashSet<string> { NodeKinds.Constructor },
            SkipParentKinds = new HashSet<string> { NodeKinds.Interface },
            SkipTypeTags = new HashSet<string> { Tags.Controller, "barrel" },
        },
    };

    public bool CanAnalyzeFile(string path) => path.EndsWith(".fragment.json", StringComparison.Ordinal);

    public bool Detect(string directory, CancellationToken ct) => false;

    public CodeGraph Analyze(string path, AnalyzerOptions options, CancellationToken ct)
    {
        var full = Path.GetFullPath(path);
        var graph = JsonExporter.Read(full);
        graph.Source.Path = full;
        graph.Source.Root = Path.GetDirectoryName(full)!;
        return graph;
    }
}
