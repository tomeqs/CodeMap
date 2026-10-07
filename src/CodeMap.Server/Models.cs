namespace CodeMap.Server;

/// <summary>Analysis switches chosen in the UI (mirrors the CLI flags).</summary>
public sealed class AnalysisSettings
{
    public bool Tests { get; set; } = true;
    public bool External { get; set; }
    public bool Git { get; set; } = true;
    public bool TypesOnly { get; set; }

    /// <summary>Keep watching the sources and re-analyze when they change.</summary>
    public bool Watch { get; set; }

    public AnalysisSettings Clone() => (AnalysisSettings)MemberwiseClone();

    /// <summary>Settings that change the produced graph (Watch does not).</summary>
    internal string CacheSignature => $"{Tests}|{External}|{Git}|{TypesOnly}";
}

public sealed class AnalyzeRequest
{
    public string Path { get; set; } = "";
    public AnalysisSettings? Settings { get; set; }

    /// <summary>Refresh the map that is already open (keep the camera, no progress screen).</summary>
    public bool Background { get; set; }
}

public sealed class CloneRequest
{
    public string Url { get; set; } = "";
    public AnalysisSettings? Settings { get; set; }
}

public sealed class WatchRequest
{
    public bool Enabled { get; set; }

    /// <summary>Project to watch; defaults to the last analyzed one.</summary>
    public string? Path { get; set; }

    public AnalysisSettings? Settings { get; set; }
}

public sealed class RecentProject
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? Origin { get; set; }
    public DateTimeOffset AnalyzedAt { get; set; }
    public AnalysisSettings Settings { get; set; } = new();
    public string Key { get; set; } = "";
    public Dictionary<string, int> Stats { get; set; } = new();
}

public sealed class UiServerOptions
{
    /// <summary>The single-file viewer (viewer/dist/index.html) served at "/".</summary>
    public required string ViewerHtml { get; init; }

    /// <summary>Preferred port; when it is taken a free one is picked.</summary>
    public int Port { get; init; } = 5180;

    /// <summary>Where recent projects, cached graphs and cloned repositories live (default ~/.codemap).</summary>
    public string? Home { get; init; }

    /// <summary>Directory the folder browser starts in.</summary>
    public string? StartDirectory { get; init; }

    /// <summary>Analyze this path right after start-up.</summary>
    public string? InitialPath { get; init; }

    public AnalysisSettings InitialSettings { get; init; } = new();

    public Action<string>? Log { get; init; }

    internal string ResolveHome() =>
        Home ?? Environment.GetEnvironmentVariable("CODEMAP_HOME")
        ?? System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codemap");
}
