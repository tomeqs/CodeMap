using System.Diagnostics;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Languages;
using CodeMap.Pipeline;
using CodeMap.Server;

namespace CodeMap.Mcp;

/// <summary>A problem the agent can fix by calling differently: shown as a tool error with this message.</summary>
internal sealed class ToolException(string message) : Exception(message);

/// <summary>An analysis that runs in the background: tools wait for it a while, then report its progress.</summary>
internal sealed class AnalysisJob
{
    public required string Path { get; init; }
    public required Task<Snapshot> Task { get; init; }
    public required CancellationTokenSource Cancel { get; init; }
    public required List<string> Log { get; init; }

    /// <summary>How many file changes the session had counted when the analysis started.</summary>
    public int ChangesBefore { get; init; }

    public Stopwatch Clock { get; } = Stopwatch.StartNew();

    public string[] LastLines(int count)
    {
        lock (Log) return Log.TakeLast(count).ToArray();
    }
}

/// <summary>
/// What the MCP server knows between calls: the current analysis and the previous one, named baselines, and graphs
/// loaded from files; the analysis in progress; whether the sources changed since (the watcher).
/// </summary>
internal sealed class CodeMapSession : IDisposable
{
    /// <summary>Baselines kept in memory; older ones are written to disk and read back when used.</summary>
    public const int BaselinesInMemory = 4;

    /// <summary>Simulations kept (the most recent ones).</summary>
    public const int SimulationsKept = 6;

    private readonly object _gate = new();
    private readonly CodeMapMcpOptions _options;
    private readonly Dictionary<string, Snapshot> _baselines = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<string> _baselineOrder = new();
    private readonly Dictionary<string, string> _spilled = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (DateTime Written, Snapshot Snapshot)> _files = new(StringComparer.Ordinal);
    private readonly List<FileSystemWatcher> _watchers = new();
    private readonly List<(string File, int At)> _changed = new(); // with the count of changes at its last change
    private readonly List<string> _recent = new(); // baselines in memory, the one used longest ago first
    private int _spillCount;
    private readonly string _spillFolder = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "codemap-mcp", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
    private readonly List<(string Name, Snapshot Snapshot)> _simulations = new();
    private int _simulationCount;
    private LanguageRegistry? _registry;
    private Rendering.MapRenderer? _renderer;
    private AnalysisJob? _job;
    private string? _watchRoot;
    private int _changeCount;

    public CodeMapSession(CodeMapMcpOptions options)
    {
        _options = options;
        Root = options.Root != null ? System.IO.Path.GetFullPath(options.Root) : null;
    }

    public CodeMapMcpOptions Options => _options;

    /// <summary>The folder relative paths are resolved against: --root, else the client's root, else the current directory.</summary>
    public string? Root { get; private set; }

    public string RootOrCurrent => Root ?? Directory.GetCurrentDirectory();

    public Snapshot? Current { get; private set; }

    public Snapshot? Previous { get; private set; }

    public AnalysisJob? Running
    {
        get { lock (_gate) return _job is { Task.IsCompleted: false } ? _job : null; }
    }

    public LanguageRegistry Registry => _registry ??= _options.Registry();

    /// <summary>Pictures of the map (started on first use: a headless browser).</summary>
    public Rendering.MapRenderer Renderer
    {
        get { lock (_gate) return _renderer ??= new Rendering.MapRenderer(_options.ViewerHtml, _options.Browser, _options.Log); }
    }

    /// <summary>Sets the root from the client (its first MCP root) unless one was given.</summary>
    public void OfferRoot(string? folder)
    {
        if (Root == null && folder != null && Directory.Exists(folder)) Root = System.IO.Path.GetFullPath(folder);
    }

    public string Resolve(string path) => System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(path) ? path : System.IO.Path.Combine(RootOrCurrent, path));

    // ------------------------------------------------------------------ analysis

    /// <summary>Starts analyzing <paramref name="path"/> (cancelling another analysis in progress), or returns the one already running for it.</summary>
    public AnalysisJob Start(string path, AnalyzerOptions? analyzer = null)
    {
        lock (_gate)
        {
            if (_job is { Task.IsCompleted: false } running)
            {
                if (running.Path == path) return running;
                running.Cancel.Cancel();
            }

            var cancel = new CancellationTokenSource();
            var log = new List<string>();
            void Log(string line)
            {
                lock (log) log.Add(line);
                _options.Log.WriteLine(line);
            }

            var options = Clone(analyzer ?? _options.Analyzer);
            options.Log = Log;
            // The result is published before the task completes: whoever awaits it finds it as the current analysis.
            AnalysisJob? job = null;
            var go = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var task = Task.Run(async () =>
            {
                await go.Task.ConfigureAwait(false);
                var snapshot = Analyze(path, options, cancel.Token);
                Publish(job!, snapshot);
                return snapshot;
            }, cancel.Token);
            job = new AnalysisJob { Path = path, Log = log, Cancel = cancel, Task = task, ChangesBefore = _changeCount };
            _job = job;
            go.SetResult();
            return job;
        }
    }

    /// <summary>Waits for an analysis up to <paramref name="wait"/>: its result, or null while it still runs.</summary>
    public static async Task<Snapshot?> WaitAsync(AnalysisJob job, TimeSpan wait, CancellationToken ct)
    {
        var finished = await Task.WhenAny(job.Task, Task.Delay(wait, ct)).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        if (finished != job.Task) return null;
        return await job.Task.ConfigureAwait(false); // throws the analysis' error
    }

    /// <summary>
    /// The graph a tool works on: <c>current</c> (null), <c>previous</c>, a baseline's name, or a .codemap.json file. With
    /// no analysis yet, the root is analyzed first (waiting up to 45 s).
    /// </summary>
    public async Task<Snapshot> GraphAsync(string? reference, CancellationToken ct)
    {
        reference = string.IsNullOrWhiteSpace(reference) ? "current" : reference.Trim();
        if (reference.Equals("current", StringComparison.OrdinalIgnoreCase))
        {
            if (Current != null) return Current;
            var job = Running ?? Start(Root ?? Directory.GetCurrentDirectory());
            return await WaitAsync(job, TimeSpan.FromSeconds(45), ct).ConfigureAwait(false)
                   ?? throw new ToolException($"The analysis of {job.Path} is still running ({job.Clock.Elapsed.TotalSeconds:0} s). Call analyze to wait for it.");
        }

        if (reference.Equals("previous", StringComparison.OrdinalIgnoreCase))
            return Previous ?? throw new ToolException("There is no previous analysis: it appears after analyze with refresh: true.");

        if (Simulation(reference) is { } simulation) return simulation;
        if (Baseline(reference) is { } baseline) return baseline;
        if (reference.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            var path = Resolve(reference);
            if (!File.Exists(path)) throw new ToolException($"No file {path}.");
            lock (_gate)
            {
                var written = File.GetLastWriteTimeUtc(path);
                if (_files.TryGetValue(path, out var cached) && cached.Written == written) return cached.Snapshot;
                var snapshot = Load(path);
                _files[path] = (written, snapshot);
                return snapshot;
            }
        }

        throw new ToolException($"Unknown graph '{reference}'. Use current, previous, a baseline ({string.Join(", ", BaselineNames().DefaultIfEmpty("none saved"))}), a simulation ({string.Join(", ", SimulationNames().DefaultIfEmpty("none"))}) or a .codemap.json path.");
    }

    private Snapshot Analyze(string path, AnalyzerOptions options, CancellationToken ct)
    {
        var clock = Stopwatch.StartNew();
        if (File.Exists(path) && path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return Load(path);
        var raw = GraphPipeline.BuildRaw(path, options, Registry, ct);
        ct.ThrowIfCancellationRequested();
        var graph = GraphPipeline.Derive(raw);
        options.Log?.Invoke($"Analysis finished in {clock.Elapsed.TotalSeconds:0.0}s: {graph.Nodes.Count} nodes, {graph.Edges.Count} edges");
        return new Snapshot(graph.Source.Name, path, raw, graph, "analysis", clock.Elapsed.TotalSeconds);
    }

    /// <summary>A saved map, derived again (so it gets what this version computes) with its git data as saved.</summary>
    private Snapshot Load(string path)
    {
        var clock = Stopwatch.StartNew();
        var saved = JsonExporter.Read(path);
        var raw = RawGraph.FromDerived(saved, Registry);
        var graph = GraphPipeline.Derive(raw);
        return new Snapshot(graph.Source.Name, path, raw, graph, "file", clock.Elapsed.TotalSeconds);
    }

    private void Publish(AnalysisJob job, Snapshot snapshot)
    {
        lock (_gate)
        {
            if (_job != job) return; // a newer analysis took its place
            if (Current != null && Current.Origin != "file") Previous = Current;
            Current = snapshot;
            // Files changed while the analysis ran may have been read before they changed: for the map of the same
            // folder they stay "changed since the analysis". Everything before it is in the map.
            var sameFolder = snapshot.Origin == "analysis" && _watchRoot != null && string.Equals(_watchRoot, snapshot.Graph.Source.Root, StringComparison.Ordinal);
            var before = sameFolder ? job.ChangesBefore : int.MaxValue;
            _changed.RemoveAll(c => c.At <= before);
            for (var i = 0; i < _changed.Count; i++) _changed[i] = (_changed[i].File, _changed[i].At - before);
            _changeCount = sameFolder ? Math.Max(0, _changeCount - before) : 0;
        }

        if (_options.Watch && snapshot.Origin == "analysis") Watch(snapshot.Graph.Source.Root);
    }

    private static AnalyzerOptions Clone(AnalyzerOptions o) => new()
    {
        IncludeExternal = o.IncludeExternal,
        IncludeGenerated = o.IncludeGenerated,
        IncludeTests = o.IncludeTests,
        Git = o.Git,
        GitSince = o.GitSince,
        GitMaxCommits = o.GitMaxCommits,
        CodeChecks = o.CodeChecks,
    };

    // ------------------------------------------------------------------ simulations

    /// <summary>Keeps a simulated map under a name (sim-N unless given); the oldest of more than <see cref="SimulationsKept"/> is dropped.</summary>
    public string AddSimulation(Snapshot snapshot, string? name = null)
    {
        lock (_gate)
        {
            name ??= $"sim-{++_simulationCount}";
            _simulations.RemoveAll(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
            _simulations.Add((name, snapshot));
            while (_simulations.Count > SimulationsKept) _simulations.RemoveAt(0);
            return name;
        }
    }

    public Snapshot? Simulation(string name)
    {
        lock (_gate) return _simulations.LastOrDefault(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Snapshot;
    }

    public IEnumerable<string> SimulationNames()
    {
        lock (_gate) return _simulations.Select(x => x.Name).ToList();
    }

    /// <summary>A graph the session already holds, without loading or analyzing anything.</summary>
    public Snapshot? Find(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference) || reference.Equals("current", StringComparison.OrdinalIgnoreCase)) return Current;
        if (reference.Equals("previous", StringComparison.OrdinalIgnoreCase)) return Previous;
        return Simulation(reference) ?? (IsSpilled(reference) ? null : Baseline(reference));
    }

    // ------------------------------------------------------------------ baselines

    public IEnumerable<string> BaselineNames()
    {
        lock (_gate) return _baselineOrder.ToList();
    }

    /// <summary>Keeps a graph under a name; the oldest of more than <see cref="BaselinesInMemory"/> goes to disk.</summary>
    public void Save(string name, Snapshot snapshot)
    {
        lock (_gate)
        {
            _baselineOrder.Remove(name);
            if (_spilled.Remove(name, out var replaced)) TryDelete(replaced);
            _baselines[name] = snapshot;
            _baselineOrder.Add(name);
            Used(name);
            SpillBeyondLimit();
        }
    }

    /// <summary>A baseline in memory was saved or used just now.</summary>
    private void Used(string name)
    {
        _recent.RemoveAll(n => n.Equals(name, StringComparison.OrdinalIgnoreCase));
        _recent.Add(name);
    }

    /// <summary>Keeps <see cref="BaselinesInMemory"/> baselines in memory: the ones used longest ago go to disk.</summary>
    private void SpillBeyondLimit()
    {
        while (_baselines.Count > BaselinesInMemory)
        {
            var oldest = _recent.FirstOrDefault(_baselines.ContainsKey) ?? _baselines.Keys.First();
            Directory.CreateDirectory(_spillFolder);
            // Numbered, not named after the baseline: "v1.0" and "v1_0" would be one file.
            var file = System.IO.Path.Combine(_spillFolder, $"baseline-{++_spillCount}.codemap.json");
            using (var stream = File.Create(file)) JsonExporter.Write(_baselines[oldest].Graph, stream);
            _baselines.Remove(oldest);
            _recent.RemoveAll(n => n.Equals(oldest, StringComparison.OrdinalIgnoreCase));
            _spilled[oldest] = file;
        }
    }

    public bool Delete(string name)
    {
        lock (_gate)
        {
            var known = _baselineOrder.Remove(name);
            _baselines.Remove(name);
            _recent.RemoveAll(n => n.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (_spilled.Remove(name, out var file)) TryDelete(file);
            return known;
        }
    }

    public Snapshot? Baseline(string name)
    {
        string? file;
        lock (_gate)
        {
            if (_baselines.TryGetValue(name, out var snapshot))
            {
                Used(name);
                return snapshot;
            }

            if (!_spilled.TryGetValue(name, out file)) return null;
        }

        // Read back outside the lock (parsing and deriving a map takes seconds; the watchers and every tool's answer
        // wait on it), and kept: the next use is as likely as this one. Another baseline goes to disk for it.
        var loaded = Load(file);
        lock (_gate)
        {
            if (_baselines.TryGetValue(name, out var meanwhile)) return meanwhile;
            if (!_spilled.TryGetValue(name, out var still) || still != file) return loaded; // deleted or saved anew meanwhile
            _spilled.Remove(name);
            TryDelete(file);
            _baselines[name] = loaded;
            Used(name);
            SpillBeyondLimit();
            return loaded;
        }
    }

    /// <summary>A baseline is on disk (it is read back when used).</summary>
    public bool IsSpilled(string name)
    {
        lock (_gate) return _spilled.ContainsKey(name);
    }

    // ------------------------------------------------------------------ staleness

    /// <summary>Files changed since the current analysis (relative to its root), and how many changes in all.</summary>
    public (IReadOnlyList<string> Files, int Count) Changes
    {
        get { lock (_gate) return (_changed.Select(c => c.File).ToList(), _changeCount); }
    }

    private void Watch(string root)
    {
        lock (_gate)
        {
            if (_watchRoot == root && _watchers.Count > 0) return;
            StopWatching();
            try
            {
                _watchers.AddRange(SourceChangeFilter.Watch(root, Registry, OnChanged));
                _watchRoot = root;
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or PlatformNotSupportedException or UnauthorizedAccessException)
            {
                _options.Log.WriteLine($"Not watching {root}: {ex.Message}");
            }
        }
    }

    private void OnChanged(object sender, FileSystemEventArgs e)
    {
        var root = _watchRoot;
        if (root == null) return;
        var relevant = SourceChangeFilter.IsRelevant(e.FullPath, Registry, root) || e is RenamedEventArgs r && SourceChangeFilter.IsRelevant(r.OldFullPath, Registry, root);
        if (!relevant) return;
        var relative = System.IO.Path.GetRelativePath(root, e.FullPath).Replace('\\', '/');
        lock (_gate)
        {
            Changed(relative, limit: 20);
        }
    }

    /// <summary>Marks a file as changed (tests, and clients that report their edits).</summary>
    internal void MarkChanged(string relativePath)
    {
        lock (_gate)
        {
            Changed(relativePath, limit: int.MaxValue);
        }
    }

    /// <summary>Counts a change and remembers its file (up to a limit) with when it last changed.</summary>
    private void Changed(string file, int limit)
    {
        _changeCount++;
        var known = _changed.FindIndex(c => c.File == file);
        if (known >= 0) _changed[known] = (file, _changeCount);
        else if (_changed.Count < limit) _changed.Add((file, _changeCount));
    }

    private void StopWatching()
    {
        foreach (var watcher in _watchers) watcher.Dispose();
        _watchers.Clear();
        _watchRoot = null;
    }

    public void Dispose()
    {
        Rendering.MapRenderer? renderer;
        lock (_gate)
        {
            _job?.Cancel.Cancel();
            StopWatching();
            renderer = _renderer;
            _renderer = null;
        }

        renderer?.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(10));

        if (Directory.Exists(_spillFolder))
        {
            try { Directory.Delete(_spillFolder, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static void TryDelete(string file)
    {
        try { File.Delete(file); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
