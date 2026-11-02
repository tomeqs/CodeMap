using System.Text.Json;
using System.Text.Json.Nodes;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// Whole maps against stored copies: any change to what the analysis writes shows up here.
/// - shop: samples/Shop (C#);
/// - ts-mini: a TypeScript-shaped raw graph written by hand (ts-mini.fragment.json) after the shared analysis;
///   the viewer's smoke tests load it too.
/// After an intended change, regenerate with CODEMAP_UPDATE_GOLDEN=1 dotnet test --filter GoldenTests and review
/// the diff of Golden/*.codemap.json.
/// </summary>
public class GoldenTests
{
    [Fact]
    public void Shop_map_matches_the_golden_file()
    {
        var root = RepoRoot();
        var graph = CodeMapAnalyzer.Analyze(Path.Combine(root, "samples", "Shop", "Shop.sln"), new AnalyzerOptions { Git = false });
        AssertGolden("shop", Normalize(graph, root));
    }

    [Fact]
    public void Typescript_shaped_map_matches_the_golden_file()
    {
        AssertGolden("ts-mini", Normalize(TsMini(), RepoRoot()));
    }

    /// <summary>The TypeScript-shaped test map after the shared analysis.</summary>
    internal static CodeGraph TsMini() =>
        CodeMapAnalyzer.Analyze(Path.Combine(RepoRoot(), "tests", "CodeMap.Tests", "Golden", "ts-mini.fragment.json"),
            new LanguageRegistry(new[] { new FragmentLanguage() }), new AnalyzerOptions { Git = false });

    private static void AssertGolden(string name, string actual)
    {
        var golden = Path.Combine(RepoRoot(), "tests", "CodeMap.Tests", "Golden", name + ".codemap.json");
        if (Environment.GetEnvironmentVariable("CODEMAP_UPDATE_GOLDEN") == "1")
        {
            File.WriteAllText(golden, actual);
            return;
        }

        var expected = File.ReadAllText(golden).ReplaceLineEndings("\n");
        if (expected == actual) return;

        var actualPath = Path.ChangeExtension(golden, ".actual.json");
        File.WriteAllText(actualPath, actual);
        var expectedLines = expected.Split('\n');
        var actualLines = actual.Split('\n');
        var line = 0;
        while (line < expectedLines.Length && line < actualLines.Length && expectedLines[line] == actualLines[line]) line++;
        Assert.Fail($"The {name} map differs from {golden} at line {line + 1} (written to {actualPath}):\n" +
                    $"  expected: {expectedLines.ElementAtOrDefault(line)?.Trim()}\n  actual:   {actualLines.ElementAtOrDefault(line)?.Trim()}");
    }

    /// <summary>Indented JSON without what changes from run to run: time, version, absolute paths, and the order of tags and metrics.</summary>
    internal static string Normalize(CodeGraph graph, string root)
    {
        var json = JsonNode.Parse(JsonExporter.Serialize(graph))!.AsObject();
        json["generatedAt"] = "(time)";
        json["generator"]!["version"] = "(version)";
        foreach (var node in json["nodes"]!.AsArray().Select(n => n!.AsObject()))
        {
            if (node["tags"] is JsonArray tags)
            {
                node["tags"] = new JsonArray(tags.Select(t => (string)t!).Order(StringComparer.Ordinal).Select(t => (JsonNode)t!).ToArray());
            }

            if (node["metrics"] is JsonObject metrics)
            {
                var sorted = new JsonObject();
                foreach (var (key, value) in metrics.OrderBy(m => m.Key, StringComparer.Ordinal).ToList()) sorted[key] = value?.DeepClone();
                node["metrics"] = sorted;
            }
        }

        var text = json.ToJsonString(new JsonSerializerOptions(JsonExporter.Options) { WriteIndented = true }).ReplaceLineEndings("\n");
        var rootText = JsonSerializer.Serialize(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar), JsonExporter.Options).Trim('"');
        return text.Replace(rootText, "(repo)") + "\n";
    }

    internal static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "samples", "Shop", "Shop.sln"))) return dir.FullName;
        }

        throw new InvalidOperationException("Repository root (with samples/Shop) not found above " + AppContext.BaseDirectory);
    }
}
