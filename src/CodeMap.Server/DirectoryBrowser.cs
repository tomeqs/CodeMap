namespace CodeMap.Server;

public sealed record BrowseEntry(string Name, string Path, string Kind, bool HasCode);

public sealed record BrowseResult(string Path, string? Parent, IReadOnlyList<BrowseEntry> Entries, IReadOnlyList<BrowseEntry> Places);

/// <summary>
/// Server-side folder browser for the UI: a browser page cannot see absolute paths on disk, so the
/// local server lists folders and highlights solutions and projects.
/// </summary>
public static class DirectoryBrowser
{
    private static readonly string[] SolutionExtensions = { ".sln", ".slnx", ".slnf" };
    private static readonly HashSet<string> Skipped = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", "node_modules", "packages", "TestResults" };

    public static BrowseResult Browse(string? path, string startDirectory)
    {
        var places = Places(startDirectory);
        if (string.IsNullOrWhiteSpace(path)) path = startDirectory;
        var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(ExpandHome(path.Trim())));
        if (File.Exists(full)) full = Path.GetDirectoryName(full)!;
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException($"Folder not found: {path}");

        var entries = new List<BrowseEntry>();
        try
        {
            foreach (var file in Directory.EnumerateFiles(full))
            {
                var ext = Path.GetExtension(file).ToLowerInvariant();
                if (SolutionExtensions.Contains(ext)) entries.Add(new BrowseEntry(Path.GetFileName(file), file, "solution", true));
                else if (ext == ".csproj") entries.Add(new BrowseEntry(Path.GetFileName(file), file, "project", true));
            }

            foreach (var dir in Directory.EnumerateDirectories(full))
            {
                var name = Path.GetFileName(dir);
                if (name.StartsWith('.') || Skipped.Contains(name)) continue;
                entries.Add(new BrowseEntry(name, dir, "folder", ContainsCode(dir)));
            }
        }
        catch (UnauthorizedAccessException)
        {
            // Show what we could read; the UI still allows going up.
        }

        var ordered = entries
            .OrderBy(e => e.Kind switch { "solution" => 0, "project" => 1, _ => 2 })
            .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return new BrowseResult(full, Directory.GetParent(full)?.FullName, ordered, places);
    }

    /// <summary>Finds the best thing to analyze inside a folder: a lone solution, otherwise the folder itself.</summary>
    public static string ResolveAnalysisTarget(string folder)
    {
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

    private static bool ContainsCode(string dir)
    {
        try
        {
            return Directory.EnumerateFiles(dir).Any(f =>
                f.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || SolutionExtensions.Any(e => f.EndsWith(e, StringComparison.OrdinalIgnoreCase)));
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    private static List<BrowseEntry> Places(string startDirectory)
    {
        var places = new List<BrowseEntry>();
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (Directory.Exists(startDirectory)) places.Add(new BrowseEntry("Start folder", startDirectory, "place", ContainsCode(startDirectory)));
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
