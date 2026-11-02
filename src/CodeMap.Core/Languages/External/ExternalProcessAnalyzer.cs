using System.Diagnostics;
using System.Text;
using System.Text.Json;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Model;

namespace CodeMap.Languages.External;

/// <summary>
/// A language analyzed by a separate program (a plugin, see docs/plugins.md): CodeMap writes the request to its
/// stdin, the program writes the raw graph to a file and reports progress on stderr. A plugin can be written in
/// whatever suits the language (TypeScript's runs on Node with the TypeScript compiler).
/// </summary>
public sealed class ExternalProcessAnalyzer : ILanguageAnalyzer
{
    private const int LastLines = 20;

    public ExternalProcessAnalyzer(PluginManifest manifest)
    {
        Manifest = manifest;
        Info = manifest.ToLanguageInfo();
        var seconds = Environment.GetEnvironmentVariable("CODEMAP_PLUGIN_TIMEOUT");
        if (int.TryParse(seconds, out var s) && s > 0) Timeout = TimeSpan.FromSeconds(s);
    }

    public PluginManifest Manifest { get; }
    public LanguageInfo Info { get; }

    /// <summary>How long one analysis may take (none by default; CODEMAP_PLUGIN_TIMEOUT in seconds).</summary>
    public TimeSpan? Timeout { get; set; }

    public bool CanAnalyzeFile(string path)
    {
        var name = Path.GetFileName(path);
        return Manifest.Detect.Inputs.Any(pattern => Matches(pattern, name));
    }

    /// <summary>A folder holds the language when one of its project files has source files at or below it.</summary>
    public bool Detect(string directory, CancellationToken ct)
    {
        var markers = new HashSet<string>(Manifest.Detect.Markers, StringComparer.OrdinalIgnoreCase);
        var sources = new HashSet<string>(Manifest.Detect.Sources, StringComparer.OrdinalIgnoreCase);
        var ignored = new HashSet<string>(Manifest.Detect.IgnoreDirs, StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<(string Dir, bool InProject)>();
        pending.Push((directory, false));
        while (pending.Count > 0)
        {
            ct.ThrowIfCancellationRequested();
            var (dir, inProject) = pending.Pop();
            string[] files, dirs;
            try
            {
                files = Directory.GetFiles(dir);
                dirs = Directory.GetDirectories(dir);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                continue;
            }

            inProject |= files.Any(f => markers.Contains(Path.GetFileName(f)));
            if (inProject && files.Any(f => IsSource(f, sources))) return true;
            foreach (var sub in dirs)
            {
                var name = Path.GetFileName(sub);
                if (!ignored.Contains(name) && !name.StartsWith('.')) pending.Push((sub, inProject));
            }
        }

        return false;
    }

    public IEnumerable<(string File, string Kind)> MarkersIn(string directory) =>
        Directory.EnumerateFiles(directory)
            .Where(f => Manifest.Detect.Markers.Contains(Path.GetFileName(f), StringComparer.OrdinalIgnoreCase))
            .Select(f => (f, "project"));

    public bool IsWatched(string path)
    {
        var name = Path.GetFileName(path);
        var sources = new HashSet<string>(Manifest.Detect.Sources, StringComparer.OrdinalIgnoreCase);
        if (sources.Contains(Path.GetExtension(name))) return IsSource(path, sources); // not .d.ts, not .min.js
        return Manifest.Detect.Markers.Contains(name, StringComparer.OrdinalIgnoreCase) || Manifest.Detect.Inputs.Any(p => Matches(p, name)); // tsconfig.app.json…
    }

    public IReadOnlyCollection<string> IgnoredFolders => Manifest.Detect.IgnoreDirs;

    public string? Unavailable => Manifest.Runtime is { } runtime && Manifest.Command[0] == runtime.Name ? RuntimeLocator.Find(runtime).Problem : null;

    public CodeGraph Analyze(string path, AnalyzerOptions options, CancellationToken ct)
    {
        var log = options.Log ?? (_ => { });
        var full = Path.GetFullPath(path);
        var root = Directory.Exists(full) ? full : Path.GetDirectoryName(full)!;
        var (executable, arguments) = ResolveCommand();

        var temp = Path.Combine(Path.GetTempPath(), "codemap-" + Manifest.Id + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            var output = Path.Combine(temp, "fragment.json");
            var request = JsonSerializer.Serialize(new
            {
                protocol = PluginManifest.SupportedProtocol,
                command = "analyze",
                root,
                target = full,
                output,
                codemapVersion = typeof(CodeGraph).Assembly.GetName().Version?.ToString(3),
                options = new { includeTests = options.IncludeTests, includeGenerated = options.IncludeGenerated, includeExternal = options.IncludeExternal },
            });

            var lastLines = new Queue<string>();
            var started = Stopwatch.StartNew();
            var exitCode = Run(executable, arguments, request, line =>
            {
                log($"  [{Manifest.Id}] {line}");
                lock (lastLines)
                {
                    lastLines.Enqueue(line);
                    if (lastLines.Count > LastLines) lastLines.Dequeue();
                }
            }, ct);

            if (exitCode != 0)
            {
                throw new InvalidOperationException($"{Info.Name} analysis failed (exit code {exitCode}).{Environment.NewLine}{string.Join(Environment.NewLine, lastLines)}".TrimEnd());
            }

            if (!File.Exists(output)) throw new InvalidOperationException($"{Info.Name} analysis wrote no result.");
            var graph = FragmentValidator.Validate(JsonExporter.Read(output), Manifest, root);
            log($"  {Info.Name}: {graph.Nodes.Count} nodes in {started.Elapsed.TotalSeconds:0.0}s");
            return graph;
        }
        finally
        {
            try { Directory.Delete(temp, recursive: true); }
            catch { /* best effort */ }
        }
    }

    /// <summary>The program to start and its arguments, with the plugin's files (./x) made absolute.</summary>
    private (string Executable, List<string> Arguments) ResolveCommand()
    {
        var first = Manifest.Command[0];
        string executable;
        if (Manifest.Runtime is { } runtime && string.Equals(first, runtime.Name, StringComparison.Ordinal))
        {
            var (found, problem) = RuntimeLocator.Find(runtime);
            executable = found?.Path ?? throw new InvalidOperationException(problem);
        }
        else
        {
            executable = PluginFile(first);
        }

        return (executable, Manifest.Command.Skip(1).Select(PluginFile).ToList());
    }

    private string PluginFile(string argument) =>
        argument.StartsWith("./", StringComparison.Ordinal) ? Path.Combine(Manifest.Directory, argument[2..].Replace('/', Path.DirectorySeparatorChar)) : argument;

    private int Run(string executable, List<string> arguments, string request, Action<string> onLine, CancellationToken ct)
    {
        var info = new ProcessStartInfo(executable)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Manifest.Directory,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);

        using var process = Process.Start(info) ?? throw new InvalidOperationException($"{Info.Name}: could not start {executable}.");
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) onLine(e.Data); };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) onLine(e.Data); };
        process.BeginErrorReadLine();
        process.BeginOutputReadLine();

        using var cancel = ct.Register(() => Kill(process));
        try
        {
            process.StandardInput.Write(request);
            process.StandardInput.Close();
        }
        catch (IOException)
        {
            // it exited before reading the request; its exit code and stderr say why
        }

        if (!process.WaitForExit(Timeout is { } t ? (int)Math.Min(int.MaxValue, t.TotalMilliseconds) : -1))
        {
            Kill(process);
            throw new TimeoutException($"{Info.Name} analysis did not finish within {Timeout!.Value.TotalSeconds:0} s.");
        }

        process.WaitForExit(); // the output readers catch up
        ct.ThrowIfCancellationRequested();
        return process.ExitCode;
    }

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // already gone
        }
    }

    private static bool IsSource(string file, HashSet<string> sources)
    {
        var name = Path.GetFileName(file);
        if (!sources.Contains(Path.GetExtension(name))) return false;
        return !System.Text.RegularExpressions.Regex.IsMatch(name, @"\.d\.[cm]?ts$|\.min\.[cm]?js$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    /// <summary>File name against a pattern with * wildcards ("*.ts", "tsconfig.*.json").</summary>
    internal static bool Matches(string pattern, string name)
    {
        var regex = "^" + System.Text.RegularExpressions.Regex.Escape(pattern).Replace("\\*", ".*") + "$";
        return System.Text.RegularExpressions.Regex.IsMatch(name, regex, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
}
