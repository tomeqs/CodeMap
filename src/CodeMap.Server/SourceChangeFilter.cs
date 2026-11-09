using CodeMap.Languages;

namespace CodeMap.Server;

/// <summary>
/// Which file changes can change a map, and the file watchers that see them: the live updates of the app and of the
/// VS Code extension, and the MCP server's "the analysis is stale" notice.
/// </summary>
public static class SourceChangeFilter
{
    /// <summary>
    /// A change worth a new analysis: a file some language reads, outside build output, dependencies and hidden
    /// folders (.git…) of the watched <paramref name="root"/> (the root itself may be anywhere, ~/.local/… too).
    /// </summary>
    public static bool IsRelevant(string path, LanguageRegistry registry, string? root = null)
    {
        if (!registry.Languages.Any(l => l.IsWatched(path))) return false;
        var filter = Filter(registry);
        var inside = root != null ? Path.GetRelativePath(root, path) : path;
        var parts = inside.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.SkipLast(1).Any(filter.SkipsName)) return false;

        // A folder skipped by a marker file in it (a virtual environment): its folders inside the root.
        if (root == null) return true;
        var dir = Path.GetDirectoryName(Path.GetFullPath(path));
        var top = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        while (dir != null && dir.Length > top.Length && dir.StartsWith(top, StringComparison.OrdinalIgnoreCase))
        {
            if (filter.Skips(dir)) return false;
            dir = Path.GetDirectoryName(dir);
        }

        return true;
    }

    /// <summary>Folders no language reads: build output, dependencies, virtual environments.</summary>
    public static FolderFilter Filter(LanguageRegistry registry) => FolderFilter.For(registry, "bin", "obj", "node_modules");

    /// <summary>
    /// Watchers for a root: the root itself, and each folder in it that can hold code with everything below.
    /// node_modules and build output are left out (thousands of folders that would each take a watch).
    /// The watchers raise events; the caller filters them with <see cref="IsRelevant"/>.
    /// </summary>
    public static List<FileSystemWatcher> Watch(string root, LanguageRegistry registry, FileSystemEventHandler changed, ErrorEventHandler? error = null)
    {
        var filter = Filter(registry);
        var watchers = new List<FileSystemWatcher>();
        try
        {
            watchers.Add(Create(root, recursive: false));
            foreach (var dir in Directory.EnumerateDirectories(root))
            {
                if (!filter.Skips(dir)) watchers.Add(Create(dir, recursive: true));
            }

            return watchers;
        }
        catch
        {
            foreach (var watcher in watchers) watcher.Dispose();
            throw;
        }

        FileSystemWatcher Create(string folder, bool recursive)
        {
            var watcher = new FileSystemWatcher(folder)
            {
                IncludeSubdirectories = recursive,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            watcher.Changed += changed;
            watcher.Created += changed;
            watcher.Deleted += changed;
            watcher.Renamed += (sender, e) => changed(sender, e);
            if (error != null) watcher.Error += error;
            watcher.EnableRaisingEvents = true;
            return watcher;
        }
    }
}
