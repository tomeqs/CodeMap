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

    public static IEnumerable<string> DefaultFolders()
    {
        var fromEnvironment = Environment.GetEnvironmentVariable("CODEMAP_PLUGIN_PATH");
        if (!string.IsNullOrWhiteSpace(fromEnvironment))
        {
            foreach (var folder in fromEnvironment.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) yield return folder;
        }

        var home = Environment.GetEnvironmentVariable("CODEMAP_HOME")
                   ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codemap");
        yield return Path.Combine(home, "plugins");
        yield return Path.Combine(AppContext.BaseDirectory, "plugins");
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
