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
    public static bool IsRelevant(string path, LanguageRegistry registry, string? root = null) =>
        registry.Languages.Any(l => l.IsWatched(path)) && !InSkippedFolder(path, Filter(registry), root);

    /// <summary>
    /// A file system event worth a new analysis: a file some language reads (a renamed one under its old or its new
    /// name), or a folder with such files in it that was created, renamed or moved in. Renaming a folder raises one
    /// event, for the folder: none for the files in it.
    /// </summary>
    public static bool IsRelevant(FileSystemEventArgs e, LanguageRegistry registry, string? root = null)
    {
        if (IsRelevant(e.FullPath, registry, root)) return true;
        if (e is RenamedEventArgs renamed && IsRelevant(renamed.OldFullPath, registry, root)) return true;
        return e.ChangeType is WatcherChangeTypes.Created or WatcherChangeTypes.Renamed && HoldsSources(e.FullPath, registry, root);
    }

    /// <summary>Inside build output, dependencies, a hidden folder or a folder skipped by a marker file in it (a virtual environment).</summary>
    private static bool InSkippedFolder(string path, FolderFilter filter, string? root)
    {
        var inside = root != null ? Path.GetRelativePath(root, path) : path;
        var parts = inside.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.SkipLast(1).Any(filter.SkipsName)) return true;

        // A folder skipped by a marker file in it: its folders inside the root.
        if (root == null) return false;
        var dir = Path.GetDirectoryName(Path.GetFullPath(path));
        var top = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        while (dir != null && dir.Length > top.Length && dir.StartsWith(top, StringComparison.OrdinalIgnoreCase))
        {
            if (filter.Skips(dir)) return true;
            dir = Path.GetDirectoryName(dir);
        }

        return false;
    }

    /// <summary>A folder that is read, with a file some language reads somewhere in it. A huge one is taken to have one.</summary>
    private static bool HoldsSources(string folder, LanguageRegistry registry, string? root)
    {
        if (!Directory.Exists(folder)) return false;
        var filter = Filter(registry);
        // It counts as a file in it would.
        if (InSkippedFolder(Path.Combine(folder, "_"), filter, root)) return false;
        var budget = 5000;
        var pending = new Stack<string>();
        pending.Push(folder);
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            try
            {
                foreach (var file in Directory.EnumerateFiles(dir))
                {
                    if (--budget < 0 || registry.Languages.Any(l => l.IsWatched(file))) return true;
                }

                foreach (var sub in Directory.EnumerateDirectories(dir))
                {
                    if (--budget < 0) return true;
                    if (!filter.Skips(sub)) pending.Push(sub);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // gone again, or not ours to read
            }
        }

        return false;
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
