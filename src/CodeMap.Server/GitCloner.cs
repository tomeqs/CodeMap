using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace CodeMap.Server;

/// <summary>Clones (or updates) a remote repository into ~/.codemap/repos so it can be analyzed.</summary>
public static class GitCloner
{
    private static readonly Regex Remote = new(@"^(https?://|ssh://|git://|git@[\w.-]+:)[^\s]+$", RegexOptions.IgnoreCase);

    public static bool IsValidUrl(string url) => !string.IsNullOrWhiteSpace(url) && !url.StartsWith('-') && Remote.IsMatch(url.Trim());

    /// <summary>"https://github.com/dotnet/eShop.git" → "dotnet-eShop".</summary>
    public static string FolderName(string url)
    {
        var path = url.Trim().TrimEnd('/');
        if (path.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) path = path[..^4];
        var parts = path.Split('/', ':').Where(p => p.Length > 0).ToList();
        var name = parts.Count >= 2 ? parts[^2] + "-" + parts[^1] : parts.LastOrDefault() ?? "repo";
        var clean = Regex.Replace(name, @"[^\w.-]", "_").Trim('.');
        return clean.Length == 0 ? "repo" : clean;
    }

    public static async Task<string> CloneAsync(string url, string reposDir, int depth, Action<string> log, CancellationToken ct)
    {
        if (!IsValidUrl(url)) throw new ArgumentException("Enter an https://, ssh:// or git@ repository URL.");
        url = url.Trim();
        Directory.CreateDirectory(reposDir);
        var target = Path.Combine(reposDir, FolderName(url));

        if (Directory.Exists(Path.Combine(target, ".git")))
        {
            var origin = (await RunAsync(target, new[] { "remote", "get-url", "origin" }, _ => { }, ct)).Trim();
            if (string.Equals(origin, url, StringComparison.OrdinalIgnoreCase))
            {
                log($"Updating {target}");
                await RunAsync(target, new[] { "pull", "--ff-only", "--progress" }, log, ct);
                return target;
            }

            for (var i = 2; Directory.Exists(target); i++) target = Path.Combine(reposDir, FolderName(url) + "-" + i);
        }

        log($"Cloning {url}");
        await RunAsync(reposDir, new[] { "clone", "--depth", depth.ToString(), "--progress", "--", url, target }, log, ct);
        return target;
    }

    private static async Task<string> RunAsync(string workingDirectory, IEnumerable<string> args, Action<string> log, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("git")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0"; // never hang waiting for credentials

        Process? started;
        try
        {
            started = Process.Start(psi);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            started = null;
        }

        using var process = started ?? throw new InvalidOperationException("Could not start git. Is it installed and on PATH?");
        using var registration = ct.Register(() =>
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
        });

        var stdout = process.StandardOutput.ReadToEndAsync(ct);
        var stderr = new StringBuilder();
        var lastLog = DateTime.MinValue;
        var buffer = new char[512];
        var line = new StringBuilder();
        int read;
        // git reports progress on stderr, rewriting the line with '\r'.
        while ((read = await process.StandardError.ReadAsync(buffer, ct)) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                var c = buffer[i];
                if (c is '\r' or '\n')
                {
                    if (line.Length == 0) continue;
                    var text = line.ToString();
                    stderr.AppendLine(text);
                    if (c == '\n' || DateTime.UtcNow - lastLog > TimeSpan.FromMilliseconds(400))
                    {
                        log(text);
                        lastLog = DateTime.UtcNow;
                    }

                    line.Clear();
                }
                else
                {
                    line.Append(c);
                }
            }
        }

        await process.WaitForExitAsync(ct);
        ct.ThrowIfCancellationRequested();
        if (process.ExitCode != 0)
        {
            var message = stderr.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault()?.Trim() ?? "unknown error";
            throw new InvalidOperationException($"git failed: {message}");
        }

        return await stdout;
    }
}
