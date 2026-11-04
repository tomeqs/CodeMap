using System.Diagnostics;
using System.Globalization;

namespace CodeMap.Analysis;

/// <summary>Per-file change statistics read from <c>git log --numstat</c>.</summary>
public sealed class GitHistory
{
    public sealed class FileStats
    {
        public int Commits { get; set; }

        /// <summary>Which commits (by their position in the log) touched the file: a type over several files counts each once.</summary>
        public HashSet<int> CommitIndexes { get; } = new();

        public int Churn { get; set; }
        public HashSet<string> Authors { get; } = new(StringComparer.OrdinalIgnoreCase);
        public long LastCommitUnix { get; set; }
    }

    public Dictionary<string, FileStats> Files { get; } = new(StringComparer.Ordinal);
    public string? Branch { get; private set; }
    public string? Head { get; private set; }
    public int CommitCount { get; private set; }

    /// <summary>A shallow clone (<c>git clone --depth</c>): the history ends early, so its metrics see only part of it.</summary>
    public bool Shallow { get; private set; }

    /// <summary>Files touched by each commit (absolute paths), newest first. Used for change coupling.</summary>
    public List<string[]> Commits { get; } = new();

    /// <summary>Returns null when <paramref name="directory"/> is not inside a git work tree or git is missing.</summary>
    public static GitHistory? Read(string directory, string? since, int maxCommits, Action<string>? log = null)
    {
        var top = Run(directory, "rev-parse", "--show-toplevel")?.Trim();
        if (string.IsNullOrEmpty(top)) return null;

        var history = new GitHistory
        {
            Branch = Run(directory, "rev-parse", "--abbrev-ref", "HEAD")?.Trim(),
            Head = Run(directory, "rev-parse", "HEAD")?.Trim(),
            Shallow = Run(directory, "rev-parse", "--is-shallow-repository")?.Trim() == "true",
        };

        var args = new List<string>
        {
            "-c", "core.quotepath=off", "log", "--no-merges", "--no-renames", "--numstat",
            "--format=@@%H\t%an\t%at", "-n", maxCommits.ToString(CultureInfo.InvariantCulture),
        };
        if (!string.IsNullOrWhiteSpace(since)) args.Add("--since=" + since);
        args.Add("--");
        args.Add(".");

        var output = Run(directory, args.ToArray());
        if (output == null) return history;

        string? author = null;
        long timestamp = 0;
        var commitFiles = new List<string>();

        void EndCommit()
        {
            if (commitFiles.Count > 0) history.Commits.Add(commitFiles.ToArray());
            commitFiles.Clear();
        }

        foreach (var line in output.Split('\n'))
        {
            if (line.StartsWith("@@", StringComparison.Ordinal))
            {
                EndCommit();
                var parts = line[2..].Split('\t');
                author = parts.Length > 1 ? parts[1] : null;
                timestamp = parts.Length > 2 && long.TryParse(parts[2], out var t) ? t : 0;
                history.CommitCount++;
                continue;
            }

            var columns = line.Split('\t');
            if (columns.Length < 3) continue;
            var path = Path.GetFullPath(Path.Combine(top, columns[2].Trim()));
            commitFiles.Add(path);
            if (!history.Files.TryGetValue(path, out var stats)) history.Files[path] = stats = new FileStats();
            stats.Commits++;
            stats.CommitIndexes.Add(history.CommitCount);
            if (int.TryParse(columns[0], out var added)) stats.Churn += added;
            if (int.TryParse(columns[1], out var deleted)) stats.Churn += deleted;
            if (author != null) stats.Authors.Add(author);
            stats.LastCommitUnix = Math.Max(stats.LastCommitUnix, timestamp);
        }

        EndCommit();
        log?.Invoke($"git: {history.CommitCount} commits, {history.Files.Count} files");
        return history;
    }

    private static string? Run(string directory, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo("git")
            {
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var arg in args) psi.ArgumentList.Add(arg);
            using var process = Process.Start(psi);
            if (process == null) return null;
            var stdout = process.StandardOutput.ReadToEndAsync();
            _ = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            return process.ExitCode == 0 ? stdout.Result : null;
        }
        catch
        {
            return null;
        }
    }
}
