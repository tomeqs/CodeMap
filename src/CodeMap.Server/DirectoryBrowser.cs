using CodeMap.Languages;

namespace CodeMap.Server;

/// <param name="Languages">Ids of the languages whose project files are in it (a file: its language).</param>
public sealed record BrowseEntry(string Name, string Path, string Kind, bool HasCode, IReadOnlyList<string>? Languages = null);

public sealed record BrowseResult(string Path, string? Parent, IReadOnlyList<BrowseEntry> Entries, IReadOnlyList<BrowseEntry> Places);

/// <summary>
/// Server-side folder browser for the UI: a browser page cannot see absolute paths on disk, so the
/// local server lists folders and highlights solutions and projects of every language CodeMap knows.
/// </summary>
public static class DirectoryBrowser
{
    /// <summary>Folders no language keeps code in; each language adds its own (dist, node_modules…).</summary>
    private static readonly string[] AlwaysSkipped = { "bin", "obj", "node_modules", "TestResults" };

    private static HashSet<string> Skipped(LanguageRegistry registry) =>
        new(AlwaysSkipped.Concat(registry.Languages.SelectMany(l => l.IgnoredFolders)), StringComparer.OrdinalIgnoreCase);

    public static BrowseResult Browse(string? path, string startDirectory, LanguageRegistry? registry = null)
    {
        registry ??= LanguageRegistry.Default;
        var skipped = Skipped(registry);
        var places = Places(startDirectory, registry);
        if (string.IsNullOrWhiteSpace(path)) path = startDirectory;
        var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(ExpandHome(path.Trim())));
        if (File.Exists(full)) full = Path.GetDirectoryName(full)!;
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException($"Folder not found: {path}");

        var entries = new List<BrowseEntry>();
        try
        {
            foreach (var language in registry.Languages)
            {
                foreach (var (file, kind) in language.MarkersIn(full))
                {
                    entries.Add(new BrowseEntry(Path.GetFileName(file), file, kind, true, new[] { language.Info.Id }));
                }
            }

            foreach (var dir in Directory.EnumerateDirectories(full))
            {
                var name = Path.GetFileName(dir);
                if (name.StartsWith('.') || skipped.Contains(name)) continue;
                var languages = LanguagesIn(dir, registry);
                entries.Add(new BrowseEntry(name, dir, "folder", languages.Count > 0, languages.Count > 0 ? languages : null));
            }
        }
        catch (UnauthorizedAccessException)
        {
            // Show what we could read; the UI still allows going up.
        }

        var ordered = entries
            .DistinctBy(e => e.Path)
            .OrderBy(e => e.Kind switch { "solution" => 0, "project" => 1, _ => 2 })
            .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return new BrowseResult(full, Directory.GetParent(full)?.FullName, ordered, places);
    }

    /// <summary>
    /// Finds the best thing to analyze inside a folder: a lone solution, unless other languages have code there
    /// too (then the folder, so they all make one map); otherwise the folder itself.
    /// </summary>
    public static string ResolveAnalysisTarget(string folder, LanguageRegistry? registry = null)
    {
        registry ??= LanguageRegistry.Default;
        if (registry.Languages.Any(l => l.Info.Id != "csharp" && l.Detect(folder, CancellationToken.None))) return folder;

        foreach (var candidate in new[] { folder, Path.Combine(folder, "src") })
        {
            if (!Directory.Exists(candidate)) continue;
            var solutions = Directory.EnumerateFiles(candidate)
                .Where(f => f.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
                .ToList();
            // Prefer the new .slnx format when both describe the same solution.
            var distinct = solutions.GroupBy(Path.GetFileNameWithoutExtension, StringComparer.OrdinalIgnoreCase)
                .Select(g => g.OrderBy(f => f.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase) ? 0 : 1).First())
                .ToList();
            if (distinct.Count == 1) return distinct[0];
        }

        return folder;
    }

    /// <summary>Languages with project files directly in a folder (cheap: one listing, no recursion).</summary>
    private static List<string> LanguagesIn(string dir, LanguageRegistry registry)
    {
        try
        {
            return registry.Languages.Where(l => l.MarkersIn(dir).Any()).Select(l => l.Info.Id).ToList();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return new List<string>();
        }
    }

    private static List<BrowseEntry> Places(string startDirectory, LanguageRegistry registry)
    {
        var places = new List<BrowseEntry>();
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (Directory.Exists(startDirectory)) places.Add(new BrowseEntry("Start folder", startDirectory, "place", LanguagesIn(startDirectory, registry).Count > 0));
        if (Directory.Exists(home)) places.Add(new BrowseEntry("Home", home, "place", false));
        foreach (var name in new[] { "source/repos", "repos", "src", "projects", "Projects", "code", "dev" })
        {
            var dir = Path.Combine(home, name);
            if (Directory.Exists(dir)) places.Add(new BrowseEntry(name, dir, "place", false));
        }

        if (OperatingSystem.IsWindows())
        {
            foreach (var drive in DriveInfo.GetDrives().Where(d => d.IsReady)) places.Add(new BrowseEntry(drive.Name, drive.RootDirectory.FullName, "place", false));
        }
        else
        {
            places.Add(new BrowseEntry("/", "/", "place", false));
        }

        return places.DistinctBy(p => p.Path).ToList();
    }

    private static string ExpandHome(string path) =>
        path == "~" || path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path.Length > 2 ? path[2..] : "")
            : path;
}
