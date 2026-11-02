using System.Text.Json;
using System.Text.Json.Nodes;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// The whole map of samples/Shop against a stored copy: any change to what the analyzer writes shows up here.
/// After an intended change, regenerate with CODEMAP_UPDATE_GOLDEN=1 dotnet test --filter GoldenTests and review
/// the diff of Golden/shop.codemap.json.
/// </summary>
public class GoldenTests
{
    [Fact]
    public void Shop_map_matches_the_golden_file()
    {
        var root = RepoRoot();
        var graph = CodeMapAnalyzer.Analyze(Path.Combine(root, "samples", "Shop", "Shop.sln"), new AnalyzerOptions { Git = false });
        var actual = Normalize(graph, root);

        var golden = Path.Combine(root, "tests", "CodeMap.Tests", "Golden", "shop.codemap.json");
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
        Assert.Fail($"The Shop map differs from {golden} at line {line + 1} (written to {actualPath}):\n" +
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
