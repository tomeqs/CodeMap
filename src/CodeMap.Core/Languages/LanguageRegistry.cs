using CodeMap.Languages.CSharp;

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

    /// <summary>The languages built into CodeMap.</summary>
    public static LanguageRegistry Default { get; } = new(new ILanguageAnalyzer[] { new CSharpAnalyzer() });

    public IReadOnlyList<ILanguageAnalyzer> Languages => _languages;

    public ILanguageAnalyzer? Find(string id) => _languages.FirstOrDefault(l => l.Info.Id == id);
}
