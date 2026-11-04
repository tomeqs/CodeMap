namespace CodeMap.Languages.External;

/// <summary>
/// Finds plugins: in the folders named by CODEMAP_PLUGIN_PATH, in ~/.codemap/plugins (CODEMAP_HOME), and in
/// plugins/ next to CodeMap itself, in that order; for one id the first one found is used. A folder is a plugin when
/// it holds a codemap-plugin.json, or a folder of plugins when its subfolders do. Never from the code being
/// analyzed: a plugin is a program that runs.
/// </summary>
public static class PluginCatalog
{
    public sealed record Result(List<PluginManifest> Plugins, List<string> Problems);

    /// <summary>
    /// CODEMAP_PLUGIN_PATH, then ~/.codemap/plugins (CODEMAP_HOME/plugins), then plugins/ next to CodeMap. Only
    /// absolute folders: a relative one would be read from the current folder, which may be the repository being
    /// analyzed, and a plugin is a program that runs.
    /// </summary>
    /// <param name="environment">Reads an environment variable (tests pass their own).</param>
    public static IEnumerable<string> DefaultFolders(Func<string, string?>? environment = null)
    {
        environment ??= Environment.GetEnvironmentVariable;
        var folders = new List<string>();
        var fromEnvironment = environment("CODEMAP_PLUGIN_PATH");
        if (!string.IsNullOrWhiteSpace(fromEnvironment))
        {
            folders.AddRange(fromEnvironment.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }

        var home = environment("CODEMAP_HOME");
        if (string.IsNullOrWhiteSpace(home))
        {
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            home = string.IsNullOrEmpty(profile) ? null : Path.Combine(profile, ".codemap");
        }

        if (home != null) folders.Add(Path.Combine(home, "plugins"));
        folders.Add(Path.Combine(AppContext.BaseDirectory, "plugins"));
        return folders.Where(Path.IsPathFullyQualified);
    }

    public static Result Discover(IEnumerable<string>? folders = null)
    {
        var plugins = new List<PluginManifest>();
        var problems = new List<string>();
        foreach (var folder in folders ?? DefaultFolders())
        {
            if (!Directory.Exists(folder)) continue;
            IEnumerable<string> manifests = File.Exists(Path.Combine(folder, PluginManifest.FileName))
                ? new[] { Path.Combine(folder, PluginManifest.FileName) }
                : Directory.EnumerateDirectories(folder).Select(d => Path.Combine(d, PluginManifest.FileName)).Where(File.Exists).OrderBy(p => p, StringComparer.Ordinal);
            foreach (var path in manifests)
            {
                try
                {
                    var manifest = PluginManifest.Load(path);
                    if (plugins.Any(p => p.Id == manifest.Id)) continue; // an earlier folder has it
                    if (plugins.FirstOrDefault(p => p.IdPrefix == manifest.IdPrefix) is { } clash)
                    {
                        problems.Add($"{path}: idPrefix '{manifest.IdPrefix}' is already used by plugin '{clash.Id}'.");
                        continue;
                    }

                    plugins.Add(manifest);
                }
                catch (InvalidDataException ex)
                {
                    problems.Add(ex.Message);
                }
            }
        }

        return new Result(plugins, problems);
    }
}
