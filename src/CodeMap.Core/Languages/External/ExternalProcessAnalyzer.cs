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

    private readonly FolderFilter _folders;
    private readonly System.Text.RegularExpressions.Regex[] _excluded;
    private readonly MarkerNames _markers;
    private readonly (System.Text.RegularExpressions.Regex Folder, string File)[] _bundles;

    public ExternalProcessAnalyzer(PluginManifest manifest)
    {
        Manifest = manifest;
        Info = manifest.ToLanguageInfo();
        _folders = new FolderFilter(manifest.Detect.IgnoreDirs, manifest.Detect.IgnoreMarkers);
        _excluded = manifest.Detect.ExcludeFiles.Select(FolderFilter.Wildcard).ToArray();
        _markers = new MarkerNames(manifest.Detect.Markers);
        _bundles = manifest.Detect.Bundles.Select(PluginManifest.BundleParts).Where(p => p != null)
            .Select(p => (FolderFilter.Wildcard(p!.Value.Folder), p.Value.File)).ToArray();
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

    /// <summary>
    /// A folder named as a bundle of the manifest (App.xcodeproj) that holds its file (project.pbxproj); names are
    /// compared without case, as everywhere else in detection.
    /// </summary>
    public bool IsBundle(string directory)
    {
        if (_bundles.Length == 0) return false;
        var full = Path.TrimEndingDirectorySeparator(directory);
        var name = Path.GetFileName(full);
        return _bundles.Any(b => b.Folder.IsMatch(name) && HasFile(full, b.File));

        static bool HasFile(string folder, string file)
        {
            try
            {
                return Directory.Exists(folder) && Directory.EnumerateFiles(folder, file, new EnumerationOptions { MatchCasing = MatchCasing.CaseInsensitive }).Any();
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                return false;
            }
        }
    }

    /// <summary>
    /// A bundle's own file (App.xcodeproj/project.pbxproj), or a bundle folder itself (one created, renamed or moved
    /// in). Not one inside another bundle: Xcode keeps a project.xcworkspace in every App.xcodeproj.
    /// </summary>
    private bool IsBundlePart(string path)
    {
        if (_bundles.Length == 0) return false;
        var name = Path.GetFileName(path);
        var folder = Path.GetDirectoryName(path);
        if (IsBundle(path)) return !InBundleFolder(folder);
        return folder != null && _bundles.Any(b => string.Equals(b.File, name, StringComparison.OrdinalIgnoreCase) && b.Folder.IsMatch(Path.GetFileName(folder)))
            && !InBundleFolder(Path.GetDirectoryName(folder));

        bool InBundleFolder(string? dir) => dir != null && _bundles.Any(b => b.Folder.IsMatch(Path.GetFileName(dir)));
    }

    /// <summary>
    /// A folder holds the language when one of its project files has source files at or below it. For a language
    /// whose code needs no project file, source files right in the folder count too (a folder of scripts); deeper
    /// down they need a project file, so a stray script in another language's repository does not make it one.
    /// </summary>
    public bool Detect(string directory, CancellationToken ct)
    {
        var markers = _markers;
        var sources = new HashSet<string>(Manifest.Detect.Sources, StringComparer.OrdinalIgnoreCase);
        if (Manifest.Detect.WithoutMarker && SourcesIn(directory, sources)) return true;
        var pending = new Stack<(string Dir, bool InProject)>();
        pending.Push((directory, MarkerAbove(directory, markers)));
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

            var bundles = dirs.Where(IsBundle).ToList();
            inProject |= files.Any(f => markers.Contains(Path.GetFileName(f))) || bundles.Count > 0;
            if (inProject && files.Any(f => IsSource(f, sources))) return true;
            foreach (var sub in dirs)
            {
                if (!_folders.Skips(sub) && !bundles.Contains(sub)) pending.Push((sub, inProject)); // a bundle is a project file, not code
            }
        }

        return false;
    }

    /// <summary>
    /// A folder inside a project (src/ of a package) has its marker above it. Looks up to the repository root
    /// (a folder with .git, checked too) and stops before the home folder, as the plugins do.
    /// </summary>
    private bool MarkerAbove(string directory, MarkerNames markers)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        for (var dir = Directory.GetParent(Path.GetFullPath(directory)); dir != null; dir = dir.Parent)
        {
            if (!string.IsNullOrEmpty(home) && string.Equals(Path.TrimEndingDirectorySeparator(dir.FullName), Path.TrimEndingDirectorySeparator(home), StringComparison.OrdinalIgnoreCase)) return false;
            try
            {
                if (dir.EnumerateFiles().Any(f => markers.Contains(f.Name))) return true;
                if (_bundles.Length > 0 && dir.EnumerateDirectories().Any(d => IsBundle(d.FullName))) return true;
                if (Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, ".git"))) return false;
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                return false;
            }
        }

        return false;
    }

    public IEnumerable<(string File, string Kind)> MarkersIn(string directory) =>
        Directory.EnumerateFiles(directory)
            .Where(f => _markers.Contains(Path.GetFileName(f)))
            .Concat(_bundles.Length == 0 ? Enumerable.Empty<string>() : Directory.EnumerateDirectories(directory).Where(IsBundle))
            .Select(f => (f, "project"));

    public bool IsWatched(string path)
    {
        var name = Path.GetFileName(path);
        var sources = new HashSet<string>(Manifest.Detect.Sources, StringComparer.OrdinalIgnoreCase);
        if (sources.Contains(Path.GetExtension(name))) return IsSource(path, sources); // not what excludeFiles names (.d.ts, .min.js…)
        return _markers.Contains(name) || Manifest.Detect.Inputs.Any(p => Matches(p, name)) || IsBundlePart(path); // tsconfig.app.json…, App.xcodeproj/project.pbxproj
    }

    public IReadOnlyCollection<string> IgnoredFolders => Manifest.Detect.IgnoreDirs;

    public IReadOnlyCollection<string> IgnoredFolderMarkers => Manifest.Detect.IgnoreMarkers;

    public string? Unavailable => Manifest.Runtime is { } runtime && Manifest.Command[0] == runtime.Name ? RuntimeLocator.Find(runtime).Problem : null;

    public CodeGraph Analyze(string path, AnalyzerOptions options, CancellationToken ct)
    {
        var log = options.Log ?? (_ => { });
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var root = Directory.Exists(full) && !IsBundle(full) ? full : Path.GetDirectoryName(full)!; // App.xcodeproj: rooted at its folder
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
                options = new { includeTests = options.IncludeTests, includeGenerated = options.IncludeGenerated, includeExternal = options.IncludeExternal, checks = options.CodeChecks },
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
        var arguments = Manifest.Command.Skip(1).Select(PluginFile).ToList();
        if (Manifest.Runtime is { } runtime && string.Equals(first, runtime.Name, StringComparison.Ordinal))
        {
            var (found, problem) = RuntimeLocator.Find(runtime);
            if (found == null) throw new InvalidOperationException(problem);
            return (found.Path, found.Arguments.Concat(arguments).ToList()); // py -3 ./src/cli.py
        }

        return (PluginFile(first), arguments);
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

    private bool SourcesIn(string directory, HashSet<string> sources)
    {
        try
        {
            return Directory.EnumerateFiles(directory).Any(f => IsSource(f, sources));
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    /// <summary>A source file: one of the source extensions, and not what the manifest excludes (*.d.ts, *.min.js).</summary>
    private bool IsSource(string file, HashSet<string> sources)
    {
        var name = Path.GetFileName(file);
        return sources.Contains(Path.GetExtension(name)) && !_excluded.Any(p => p.IsMatch(name));
    }

    /// <summary>File name against a pattern with * wildcards ("*.ts", "tsconfig.*.json").</summary>
    internal static bool Matches(string pattern, string name) => FolderFilter.Wildcard(pattern).IsMatch(name);

    /// <summary>
    /// Project file names: exact ("package.json") or with * wildcards for files named after the project
    /// ("*.vcxproj", "*.Build.cs"). Case-insensitive.
    /// </summary>
    private sealed class MarkerNames
    {
        private readonly HashSet<string> _exact = new(StringComparer.OrdinalIgnoreCase);
        private readonly System.Text.RegularExpressions.Regex[] _patterns;

        public MarkerNames(IEnumerable<string> markers)
        {
            var patterns = new List<System.Text.RegularExpressions.Regex>();
            foreach (var marker in markers)
            {
                if (marker.Contains('*')) patterns.Add(FolderFilter.Wildcard(marker));
                else _exact.Add(marker);
            }

            _patterns = patterns.ToArray();
        }

        public bool Contains(string name) => _exact.Contains(name) || _patterns.Any(p => p.IsMatch(name));
    }
}
