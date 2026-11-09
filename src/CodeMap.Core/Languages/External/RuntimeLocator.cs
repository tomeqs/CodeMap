using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace CodeMap.Languages.External;

/// <summary>
/// Finds the program a plugin runs on (node, python3…): the path in its environment variable (CODEMAP_NODE), else
/// the first of its commands (python3; python; py -3) found on the PATH that tells its version and is new enough.
/// Checked once per process.
/// </summary>
public static class RuntimeLocator
{
    /// <param name="Path">The program.</param>
    /// <param name="Version">What it said to --version (its first line), or null.</param>
    /// <param name="Arguments">Arguments that come before the plugin's own (py -3: "-3").</param>
    public sealed record Runtime(string Path, string? Version, IReadOnlyList<string> Arguments)
    {
        public Runtime(string path, string? version) : this(path, version, Array.Empty<string>()) { }
    }

    private static readonly ConcurrentDictionary<string, (Runtime? Runtime, string? Problem)> Cache = new();

    /// <summary>The runtime, or why it cannot be used.</summary>
    public static (Runtime? Runtime, string? Problem) Find(PluginManifest.RuntimeSpec spec)
    {
        var configured = spec.EnvVar != null ? Environment.GetEnvironmentVariable(spec.EnvVar) : null;
        var commands = string.Join(";", spec.Commands.Select(c => string.Join(" ", c)));
        var key = $"{spec.Name}|{spec.MinVersion}|{commands}|{configured}|{Environment.GetEnvironmentVariable("PATH")}";
        return Cache.GetOrAdd(key, _ => Locate(spec, configured));
    }

    private static (Runtime?, string?) Locate(PluginManifest.RuntimeSpec spec, string? configured)
    {
        var help = string.IsNullOrEmpty(spec.Help) ? "" : " " + spec.Help;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            // Chosen by the user (or an editor, e.g. VS Code's own Node.js): trusted, its version is not checked.
            if (!File.Exists(configured)) return (null, $"{spec.EnvVar} points to '{configured}', which does not exist.{help}");
            return (new Runtime(configured, VersionOf(configured, Array.Empty<string>())), null);
        }

        var minimum = spec.MinVersion is { Length: > 0 } min ? ParseVersion(min) : null;
        var problems = new List<string>();
        foreach (var command in spec.Commands)
        {
            var path = SearchPath(command[0]);
            if (path == null) continue;
            var arguments = command.Skip(1).ToList();
            var shown = string.Join(" ", command);
            var version = VersionOf(path, arguments);
            if (version == null)
            {
                // The Microsoft Store's python.exe alias, when Python is not installed, prints nothing and fails.
                problems.Add($"{shown} at {path} does not say its version (on Windows this is often the Microsoft Store alias of a program that is not installed)");
                continue;
            }

            if (minimum != null && ParseVersion(version) is { } actual && actual < minimum)
            {
                problems.Add($"{shown} at {path} is {version}, too old: {spec.MinVersion} or newer is needed");
                continue;
            }

            return (new Runtime(path, version, arguments), null);
        }

        if (problems.Count > 0) return (null, string.Join("; ", problems) + "." + help);
        var names = spec.Commands.Select(c => c[0]).Distinct().ToList();
        var listed = names.Count == 1 ? names[0] : string.Join(", ", names.SkipLast(1)) + " or " + names[^1];
        return (null, $"{listed} was not found on the PATH.{help}");
    }

    /// <summary>The first version number in a text, as major.minor ("Python 3.12.1" → 3.12, "v22.3.0" → 22.3, "18" → 18.0).</summary>
    public static Version? ParseVersion(string text)
    {
        var match = Regex.Match(text, @"(\d+)(?:\.(\d+))?");
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var major)) return null;
        var minor = match.Groups[2].Success && int.TryParse(match.Groups[2].Value, out var m) ? m : 0;
        return new Version(major, minor);
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

    /// <summary>The first line the program prints for --version, on stdout or stderr (Python 2 used stderr); null when it prints nothing or fails.</summary>
    private static string? VersionOf(string path, IReadOnlyList<string> arguments)
    {
        try
        {
            var info = new ProcessStartInfo(path) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in arguments) info.ArgumentList.Add(argument);
            info.ArgumentList.Add("--version");

            // Its own stdin, not ours (the protocol pipe under `codemap mcp`, which a child on Windows blocks on).
            using var process = Process.Start(info);
            if (process == null) return null;
            process.StandardInput.Close();
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(5000))
            {
                process.Kill(entireProcessTree: true);
                return null;
            }

            var text = output.Result.Trim() is { Length: > 0 } stdout ? stdout : error.Result.Trim();
            return text.Length > 0 ? text.Split('\n')[0].Trim() : null;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
