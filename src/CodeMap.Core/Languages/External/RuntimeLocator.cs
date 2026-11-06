using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace CodeMap.Languages.External;

/// <summary>
/// Finds the program a plugin runs on (e.g. node): the path in its environment variable (CODEMAP_NODE), else the
/// PATH; checks its version once per process.
/// </summary>
public static class RuntimeLocator
{
    public sealed record Runtime(string Path, string? Version);

    private static readonly ConcurrentDictionary<string, (Runtime? Runtime, string? Problem)> Cache = new();

    /// <summary>The runtime, or why it cannot be used.</summary>
    public static (Runtime? Runtime, string? Problem) Find(PluginManifest.RuntimeSpec spec)
    {
        var configured = spec.EnvVar != null ? Environment.GetEnvironmentVariable(spec.EnvVar) : null;
        var key = $"{spec.Name}|{spec.MinVersion}|{configured}|{Environment.GetEnvironmentVariable("PATH")}";
        return Cache.GetOrAdd(key, _ => Locate(spec, configured));
    }

    private static (Runtime?, string?) Locate(PluginManifest.RuntimeSpec spec, string? configured)
    {
        var help = string.IsNullOrEmpty(spec.Help) ? "" : " " + spec.Help;
        string? path;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!File.Exists(configured)) return (null, $"{spec.EnvVar} points to '{configured}', which does not exist.{help}");
            path = configured;
        }
        else
        {
            path = SearchPath(spec.Name);
            if (path == null) return (null, $"{spec.Name} was not found on the PATH.{help}");
        }

        var version = VersionOf(path);
        if (spec.MinVersion > 0 && configured == null && version != null)
        {
            var major = Regex.Match(version, @"\d+");
            if (major.Success && int.Parse(major.Value) < spec.MinVersion)
            {
                return (null, $"{spec.Name} {version} at {path} is too old: {spec.MinVersion} or newer is needed.{help}");
            }
        }

        return (new Runtime(path, version), null);
    }

    /// <summary>A program on the PATH (with the Windows extensions for executables).</summary>
    public static string? SearchPath(string name)
    {
        if (Path.IsPathRooted(name)) return File.Exists(name) ? name : null;
        var extensions = OperatingSystem.IsWindows()
            ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT").Split(';', StringSplitOptions.RemoveEmptyEntries).Prepend("")
            : new[] { "" };
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var extension in extensions)
            {
                var candidate = Path.Combine(dir.Trim('"'), name + extension);
                if (File.Exists(candidate)) return candidate;
            }
        }

        return null;
    }

    private static string? VersionOf(string path)
    {
        try
        {
            // Its own stdin, not ours (the protocol pipe under `codemap mcp`, which a child on Windows blocks on).
            using var process = Process.Start(new ProcessStartInfo(path, "--version") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false });
            if (process == null) return null;
            process.StandardInput.Close();
            var output = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(5000))
            {
                process.Kill(entireProcessTree: true);
                return null;
            }

            return output.Result.Trim() is { Length: > 0 } text ? text.Split('\n')[0].Trim() : null;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
