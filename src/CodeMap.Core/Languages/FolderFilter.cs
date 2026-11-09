using System.Text.RegularExpressions;

namespace CodeMap.Languages;

/// <summary>
/// Folders no language reads, so they are not searched, browsed or watched: hidden folders (.git…), build output and
/// dependencies by name (with * wildcards, e.g. *.egg-info), and folders holding a marker file of their own kind
/// (pyvenv.cfg: a Python virtual environment, whatever its name).
/// </summary>
public sealed class FolderFilter
{
    private readonly HashSet<string> _names = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<Regex> _patterns = new();
    private readonly string[] _markers;

    public FolderFilter(IEnumerable<string> names, IEnumerable<string>? markers = null)
    {
        foreach (var name in names.Where(n => !string.IsNullOrWhiteSpace(n)))
        {
            if (name.Contains('*')) _patterns.Add(Wildcard(name));
            else _names.Add(name);
        }

        _markers = (markers ?? Array.Empty<string>()).Where(m => !string.IsNullOrWhiteSpace(m)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    /// <summary>The folders every language skips (each adds its own) plus the given ones.</summary>
    public static FolderFilter For(LanguageRegistry registry, params string[] always) =>
        new(always.Concat(registry.Languages.SelectMany(l => l.IgnoredFolders)), registry.Languages.SelectMany(l => l.IgnoredFolderMarkers));

    /// <summary>By the name alone: hidden, or listed.</summary>
    public bool SkipsName(string name) => name.StartsWith('.') || _names.Contains(name) || _patterns.Any(p => p.IsMatch(name));

    /// <summary>By the name or by a marker file in it (looks at the disk only when there are markers).</summary>
    public bool Skips(string directory)
    {
        if (SkipsName(Path.GetFileName(Path.TrimEndingDirectorySeparator(directory)))) return true;
        foreach (var marker in _markers)
        {
            try
            {
                if (File.Exists(Path.Combine(directory, marker))) return true;
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                // unreadable: not skipped for that
            }
        }

        return false;
    }

    /// <summary>A name pattern with * wildcards, case-insensitive ("*.egg-info", "tsconfig.*.json").</summary>
    public static Regex Wildcard(string pattern) =>
        new("^" + Regex.Escape(pattern).Replace("\\*", ".*") + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}
