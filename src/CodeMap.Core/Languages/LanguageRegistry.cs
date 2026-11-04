using CodeMap.Languages.CSharp;
using CodeMap.Languages.External;

namespace CodeMap.Languages;

/// <summary>The languages an analysis can use, in order of preference (the first one that takes a file wins).</summary>
public sealed class LanguageRegistry
{
    private readonly List<ILanguageAnalyzer> _languages = new();

    public LanguageRegistry(IEnumerable<ILanguageAnalyzer> languages)
    {
        foreach (var language in languages)
        {
            if (_languages.All(l => l.Info.Id != language.Info.Id)) _languages.Add(language);
        }
    }

    private static readonly Lazy<LanguageRegistry> DefaultRegistry = new(() => WithPlugins());

    /// <summary>C#, and the language plugins installed (see <see cref="PluginCatalog"/>); found once per process.</summary>
    public static LanguageRegistry Default => DefaultRegistry.Value;

    /// <summary>C# alone.</summary>
    public static LanguageRegistry BuiltIn { get; } = new(new ILanguageAnalyzer[] { new CSharpAnalyzer() });

    /// <summary>C# and the plugins found in these folders (the usual places when none are given).</summary>
    public static LanguageRegistry WithPlugins(IEnumerable<string>? folders = null)
    {
        var found = PluginCatalog.Discover(folders);
        var languages = new List<ILanguageAnalyzer> { new CSharpAnalyzer() };
        var problems = new List<string>(found.Problems);
        foreach (var plugin in found.Plugins)
        {
            // A plugin that cannot be set up is a problem of its own: C# and the other plugins still work.
            try
            {
                languages.Add(new ExternalProcessAnalyzer(plugin));
            }
            catch (Exception ex)
            {
                problems.Add($"{Path.Combine(plugin.Directory, PluginManifest.FileName)}: {ex.Message}");
            }
        }

        return new LanguageRegistry(languages) { Problems = problems };
    }

    public IReadOnlyList<ILanguageAnalyzer> Languages => _languages;

    /// <summary>Plugins that were found but cannot be used, and why.</summary>
    public IReadOnlyList<string> Problems { get; private init; } = Array.Empty<string>();

    public ILanguageAnalyzer? Find(string id) => _languages.FirstOrDefault(l => l.Info.Id == id);

    /// <summary>Only these languages (by id, e.g. "csharp,typescript").</summary>
    public LanguageRegistry Only(IEnumerable<string> ids)
    {
        var wanted = ids.Select(i => i.Trim().ToLowerInvariant()).Where(i => i.Length > 0).ToList();
        var unknown = wanted.Where(id => Find(id) == null).ToList();
        if (unknown.Count > 0)
        {
            throw new ArgumentException($"Unknown language '{string.Join("', '", unknown)}'. Available: {string.Join(", ", _languages.Select(l => l.Info.Id))}.");
        }

        return new LanguageRegistry(_languages.Where(l => wanted.Contains(l.Info.Id))) { Problems = Problems };
    }
}
