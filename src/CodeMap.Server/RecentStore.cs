using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CodeMap.Server;

/// <summary>Recently analyzed projects (~/.codemap/recent.json) and their cached graphs (~/.codemap/cache).</summary>
public sealed class RecentStore
{
    private const int MaxEntries = 30;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _file;
    private readonly string _cacheDir;
    private readonly object _gate = new();

    public RecentStore(string home)
    {
        Directory.CreateDirectory(home);
        _file = Path.Combine(home, "recent.json");
        _cacheDir = Path.Combine(home, "cache");
        Directory.CreateDirectory(_cacheDir);
    }

    public static string KeyFor(string path, AnalysisSettings settings)
    {
        var normalized = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (OperatingSystem.IsWindows()) normalized = normalized.ToLowerInvariant();
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized + "|" + settings.CacheSignature));
        return Convert.ToHexString(hash, 0, 10).ToLowerInvariant();
    }

    public string CacheFile(string key) => Path.Combine(_cacheDir, key + ".codemap.json");

    public List<RecentProject> List()
    {
        lock (_gate)
        {
            var list = Read();
            // Entries whose cache vanished are still useful (they can be analyzed again), so keep them.
            return list;
        }
    }

    public RecentProject? Find(string key)
    {
        lock (_gate) return Read().FirstOrDefault(r => r.Key == key);
    }

    public void Upsert(RecentProject project, byte[] graph)
    {
        lock (_gate)
        {
            File.WriteAllBytes(CacheFile(project.Key), graph);
            var list = Read();
            list.RemoveAll(r => r.Key == project.Key || PathEquals(r.Path, project.Path) && r.Settings.CacheSignature == project.Settings.CacheSignature);
            list.Insert(0, project);
            foreach (var stale in list.Skip(MaxEntries)) TryDelete(CacheFile(stale.Key));
            Write(list.Take(MaxEntries).ToList());
        }
    }

    public bool Remove(string path)
    {
        lock (_gate)
        {
            var list = Read();
            var removed = list.Where(r => PathEquals(r.Path, path)).ToList();
            foreach (var r in removed) TryDelete(CacheFile(r.Key));
            list.RemoveAll(r => PathEquals(r.Path, path));
            Write(list);
            return removed.Count > 0;
        }
    }

    private List<RecentProject> Read()
    {
        try
        {
            return File.Exists(_file) ? JsonSerializer.Deserialize<List<RecentProject>>(File.ReadAllText(_file), Json) ?? new() : new();
        }
        catch (JsonException)
        {
            return new();
        }
    }

    private void Write(List<RecentProject> list)
    {
        var temp = _file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(list, Json));
        File.Move(temp, _file, overwrite: true);
    }

    private static bool PathEquals(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static void TryDelete(string file)
    {
        try { File.Delete(file); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
