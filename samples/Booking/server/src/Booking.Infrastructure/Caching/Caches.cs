using System.Collections.Concurrent;

namespace Booking.Infrastructure.Caching;

public interface ICache
{
    bool TryGet(string key, out string? value);

    void Set(string key, string value);
}

public enum CacheKind
{
    Redis,
    Memory,
}

/// <summary>Registered under the key CacheKind.Redis (an enum key).</summary>
public sealed class RedisCache : ICache
{
    private readonly ConcurrentDictionary<string, string> _entries = new();

    public bool TryGet(string key, out string? value) => _entries.TryGetValue(key, out value);

    public void Set(string key, string value) => _entries[key] = value;
}

/// <summary>Registered as an instance under the key "memory".</summary>
public sealed class MemoryCache : ICache
{
    private readonly Dictionary<string, string> _entries = new();

    public bool TryGet(string key, out string? value) => _entries.TryGetValue(key, out value);

    public void Set(string key, string value) => _entries[key] = value;
}
