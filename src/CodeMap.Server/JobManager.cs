using System.Collections.Concurrent;
using CodeMap.Analysis;
using CodeMap.Export;
using CodeMap.Model;

namespace CodeMap.Server;

public sealed class AnalysisJob
{
    public string Id { get; } = Guid.NewGuid().ToString("N")[..12];
    public string Path { get; set; } = "";
    public string? Origin { get; init; }
    public AnalysisSettings Settings { get; init; } = new();
    public bool Live { get; init; }
    public string Status { get; set; } = "running"; // running | done | error | cancelled
    public string? Error { get; set; }
    public string? Name { get; set; }
    public string? Root { get; set; }
    public string? Key { get; set; }
    public Dictionary<string, int>? Stats { get; set; }
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? FinishedAt { get; set; }

    internal List<string> Log { get; } = new();
    internal byte[]? Graph { get; set; }
    internal CancellationTokenSource Cts { get; } = new();

    public object Describe(int logLines = 200)
    {
        string[] log;
        lock (Log) log = Log.TakeLast(logLines).ToArray();
        return new { Id, Path, Origin, Live, Status, Error, Name, Key, Stats, StartedAt, FinishedAt, Settings, Log = log };
    }
}

/// <summary>
/// Runs one analysis at a time (a new request cancels the previous one), caches the results and,
/// in live mode, re-analyzes when the watched sources change.
/// </summary>
public sealed class JobManager : IDisposable
{
    private const int CloneDepth = 400;
    private readonly EventHub _hub;
    private readonly RecentStore _recent;
    private readonly string _reposDir;
    private readonly Action<string> _log;
    private readonly ConcurrentDictionary<string, AnalysisJob> _jobs = new();
    private readonly object _gate = new();
    private AnalysisJob? _current;
    private AnalysisJob? _lastCompleted;

    private FileSystemWatcher? _watcher;
    private string? _watchPath;
    private AnalysisSettings? _watchSettings;
    private Timer? _debounce;
    private bool _rerunPending;

    public JobManager(EventHub hub, RecentStore recent, string home, Action<string>? log = null)
    {
        _hub = hub;
        _recent = recent;
        _reposDir = System.IO.Path.Combine(home, "repos");
        _log = log ?? (_ => { });
    }

    public AnalysisJob? Current => _current;
    public string? WatchedPath => _watcher != null ? _watchPath : null;

    public AnalysisJob? Get(string id) => _jobs.TryGetValue(id, out var job) ? job : null;

    public AnalysisJob StartAnalysis(string path, AnalysisSettings settings, bool live = false)
    {
        var full = System.IO.Path.GetFullPath(path);
        if (!File.Exists(full) && !Directory.Exists(full)) throw new FileNotFoundException($"Path not found: {path}");
        var job = new AnalysisJob { Path = full, Settings = settings.Clone(), Live = live };
        Launch(job, null);
        return job;
    }

    public AnalysisJob StartClone(string url, AnalysisSettings settings)
    {
        if (!GitCloner.IsValidUrl(url)) throw new ArgumentException("Enter an https://, ssh:// or git@ repository URL.");
        var job = new AnalysisJob { Path = url.Trim(), Origin = url.Trim(), Settings = settings.Clone() };
        Launch(job, async (j, ct) =>
        {
            var folder = await GitCloner.CloneAsync(j.Origin!, _reposDir, CloneDepth, line => Log(j, line), ct);
            return DirectoryBrowser.ResolveAnalysisTarget(folder);
        });
        return job;
    }

    public bool Cancel()
    {
        var job = _current;
        if (job == null || job.Status != "running") return false;
        job.Cts.Cancel();
        return true;
    }

    private void Launch(AnalysisJob job, Func<AnalysisJob, CancellationToken, Task<string>>? prepare)
    {
        lock (_gate)
        {
            if (_current is { Status: "running" } running) running.Cts.Cancel();
            _current = job;
            _jobs[job.Id] = job;
            foreach (var old in _jobs.Values.OrderByDescending(j => j.StartedAt).Skip(8)) _jobs.TryRemove(old.Id, out _);
        }

        _hub.Publish(new { type = "started", jobId = job.Id, path = job.Path, live = job.Live });
        _ = Task.Run(() => RunAsync(job, prepare));
    }

    private async Task RunAsync(AnalysisJob job, Func<AnalysisJob, CancellationToken, Task<string>>? prepare)
    {
        var ct = job.Cts.Token;
        try
        {
            if (prepare != null) job.Path = await prepare(job, ct);

            var options = new AnalyzerOptions
            {
                IncludeTests = job.Settings.Tests,
                IncludeExternal = job.Settings.External,
                Git = job.Settings.Git,
                Log = line => Log(job, line),
            };

            var graph = await Task.Run(() => CodeMapAnalyzer.Analyze(job.Path, options, ct), ct);
            ct.ThrowIfCancellationRequested();
            if (job.Settings.TypesOnly) GraphView.CollapseMembers(graph);

            using var buffer = new MemoryStream();
            JsonExporter.Write(graph, buffer);
            job.Graph = buffer.ToArray();
            job.Name = graph.Source.Name;
            job.Root = graph.Source.Root;
            job.Stats = graph.Stats.Where(s => !s.Key.StartsWith("edges.", StringComparison.Ordinal)).ToDictionary(s => s.Key, s => s.Value);
            job.Key = RecentStore.KeyFor(job.Path, job.Settings);

            _recent.Upsert(new RecentProject
            {
                Path = job.Path,
                Name = graph.Source.Name,
                Kind = graph.Source.Kind,
                Origin = job.Origin,
                AnalyzedAt = DateTimeOffset.UtcNow,
                Settings = job.Settings,
                Key = job.Key,
                Stats = job.Stats,
            }, job.Graph);

            // Watch before announcing "done": whoever reacts to "done" finds the watch in place, and no change slips in between.
            if (job.Settings.Watch) StartWatching(job.Path, graph.Source.Root, job.Settings);
            else if (!job.Live) StopWatching();

            job.Status = "done";
            job.FinishedAt = DateTimeOffset.UtcNow;
            _lastCompleted = job;
            _hub.Publish(new { type = "done", jobId = job.Id, path = job.Path, name = job.Name, stats = job.Stats, live = job.Live, key = job.Key, settings = job.Settings });
            _log($"Analyzed {job.Path} in {(job.FinishedAt - job.StartedAt)?.TotalSeconds:0.0}s");
        }
        catch (OperationCanceledException)
        {
            job.Status = "cancelled";
            job.FinishedAt = DateTimeOffset.UtcNow;
            _hub.Publish(new { type = "cancelled", jobId = job.Id });
        }
        catch (Exception ex)
        {
            job.Status = "error";
            job.Error = ex.Message;
            job.FinishedAt = DateTimeOffset.UtcNow;
            Log(job, "error: " + ex.Message);
            _hub.Publish(new { type = "error", jobId = job.Id, message = ex.Message });
        }
        finally
        {
            if (_rerunPending && ReferenceEquals(_current, job))
            {
                _rerunPending = false;
                ScheduleRerun();
            }
        }
    }

    private void Log(AnalysisJob job, string line)
    {
        lock (job.Log) job.Log.Add(line);
        _hub.Publish(new { type = "log", jobId = job.Id, message = line });
    }

    // ------------------------------------------------------------------ live mode

    public bool SetWatch(bool enabled, string? path = null, AnalysisSettings? settings = null)
    {
        if (!enabled)
        {
            StopWatching();
            return false;
        }

        string root;
        if (path != null)
        {
            path = System.IO.Path.GetFullPath(path);
            // Same rule as the project loader: a solution/project file is rooted at its folder.
            root = File.Exists(path) ? System.IO.Path.GetDirectoryName(path)! : path;
            if (!Directory.Exists(root)) return false;
        }
        else if (_lastCompleted is { Root: not null } last)
        {
            path = last.Path;
            root = last.Root;
            settings ??= last.Settings;
        }
        else
        {
            return false;
        }

        var watchSettings = (settings ?? new AnalysisSettings()).Clone();
        watchSettings.Watch = true;
        StartWatching(path, root, watchSettings);
        return _watcher != null;
    }

    private void StartWatching(string path, string root, AnalysisSettings settings)
    {
        lock (_gate)
        {
            _watchSettings = settings.Clone();
            _watchSettings.Watch = true;
            if (_watcher != null && _watchPath == path) return;
            StopWatchingLocked();
            try
            {
                _watcher = new FileSystemWatcher(root)
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                };
                _watcher.Changed += OnSourceChanged;
                _watcher.Created += OnSourceChanged;
                _watcher.Deleted += OnSourceChanged;
                _watcher.Renamed += OnSourceChanged;
                _watcher.Error += (_, e) => _hub.Publish(new { type = "watch-error", message = e.GetException().Message });
                _watcher.EnableRaisingEvents = true;
                _watchPath = path;
                _debounce = new Timer(_ => ScheduleRerun(), null, Timeout.Infinite, Timeout.Infinite);
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or PlatformNotSupportedException)
            {
                _watcher?.Dispose();
                _watcher = null;
                _hub.Publish(new { type = "watch-error", message = ex.Message });
                return;
            }
        }

        _hub.Publish(new { type = "watch", path, enabled = true });
    }

    private void StopWatching()
    {
        bool wasWatching;
        lock (_gate)
        {
            wasWatching = _watcher != null;
            StopWatchingLocked();
        }

        if (wasWatching) _hub.Publish(new { type = "watch", enabled = false });
    }

    private void StopWatchingLocked()
    {
        _watcher?.Dispose();
        _watcher = null;
        _debounce?.Dispose();
        _debounce = null;
        _watchPath = null;
    }

    private void OnSourceChanged(object sender, FileSystemEventArgs e)
    {
        if (!IsRelevant(e.FullPath) && !(e is RenamedEventArgs r && IsRelevant(r.OldFullPath))) return;
        _debounce?.Change(1200, Timeout.Infinite);
    }

    internal static bool IsRelevant(string path)
    {
        var normalized = path.Replace('\\', '/');
        if (normalized.Contains("/bin/") || normalized.Contains("/obj/") || normalized.Contains("/.git/") || normalized.Contains("/node_modules/")) return false;
        var ext = System.IO.Path.GetExtension(normalized).ToLowerInvariant();
        return ext is ".cs" or ".csproj" or ".sln" or ".slnx" or ".props" or ".targets";
    }

    private void ScheduleRerun()
    {
        string? path;
        AnalysisSettings? settings;
        lock (_gate)
        {
            path = _watchPath;
            settings = _watchSettings;
            if (path == null || settings == null) return;
            if (_current is { Status: "running" })
            {
                _rerunPending = true;
                return;
            }
        }

        _hub.Publish(new { type = "changed", path });
        try
        {
            StartAnalysis(path, settings, live: true);
        }
        catch (FileNotFoundException)
        {
            StopWatching();
        }
    }

    public void Dispose()
    {
        _current?.Cts.Cancel();
        StopWatching();
    }
}
