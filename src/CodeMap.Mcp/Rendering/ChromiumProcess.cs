using System.Diagnostics;
using System.Globalization;

namespace CodeMap.Mcp.Rendering;

/// <summary>
/// A headless Chromium with its own throw-away profile and a DevTools port, started for rendering and killed with it.
/// WebGL 2 (and WebGPU) run on SwiftShader, so no GPU is needed.
/// </summary>
internal sealed class ChromiumProcess : IAsyncDisposable
{
    /// <summary>
    /// Graphics without a GPU: WebGL 2 on SwiftShader, and WebGPU on its software adapter. The Vulkan features the viewer's
    /// smoke tests add for WebGPU (viewer/bench/lib.mjs) take WebGL away from a full Chrome in headless mode, so they are
    /// only added when WebGPU is asked for.
    /// </summary>
    public static IReadOnlyList<string> GraphicsFlags(bool webgpu) => new[]
    {
        "--enable-unsafe-webgpu",
        "--use-webgpu-adapter=swiftshader",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
    }.Concat(webgpu ? new[] { "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan" } : Array.Empty<string>()).ToList();

    private readonly Process _process;
    private readonly string _profile;

    private ChromiumProcess(Process process, string profile, string webSocketUrl)
    {
        _process = process;
        _profile = profile;
        WebSocketUrl = webSocketUrl;
    }

    /// <summary>The browser's DevTools endpoint (ws://127.0.0.1:port/devtools/browser/…).</summary>
    public string WebSocketUrl { get; }

    public bool HasExited => _process.HasExited;

    public static async Task<ChromiumProcess> StartAsync(string executable, bool webgpu, CancellationToken ct)
    {
        var profile = Path.Combine(Path.GetTempPath(), "codemap-browser-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(profile);
        var psi = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "--headless=new", "--remote-debugging-port=0", $"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                     "--disable-extensions", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--mute-audio",
                     "--hide-scrollbars", "--disable-dev-shm-usage",
                 }.Concat(GraphicsFlags(webgpu)))
        {
            psi.ArgumentList.Add(arg);
        }

        // The sandbox does not start as root (containers, CI).
        if (OperatingSystem.IsLinux() && Environment.UserName == "root") psi.ArgumentList.Add("--no-sandbox");
        psi.ArgumentList.Add("about:blank");

        var process = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {executable}.");
        var stderr = new Queue<string>();
        process.OutputDataReceived += (_, _) => { };
        process.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            lock (stderr)
            {
                stderr.Enqueue(e.Data.Trim());
                if (stderr.Count > 5) stderr.Dequeue();
            }
        };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // Chromium writes the port it chose (and the browser's path) to DevToolsActivePort in the profile.
        var file = Path.Combine(profile, "DevToolsActivePort");
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (process.HasExited) break;
            if (File.Exists(file) && Parse(await ReadShared(file).ConfigureAwait(false)) is { } endpoint)
            {
                return new ChromiumProcess(process, profile, $"ws://127.0.0.1:{endpoint.Port}{endpoint.Path}");
            }

            await Task.Delay(100, ct).ConfigureAwait(false);
        }

        var exited = process.HasExited;
        Kill(process);
        TryDelete(profile);
        string said;
        lock (stderr) said = stderr.Count > 0 ? $" It said: {string.Join(" / ", stderr)}" : "";
        throw new InvalidOperationException((exited
            ? $"{Path.GetFileName(executable)} stopped right after starting (exit code {process.ExitCode})."
            : $"{Path.GetFileName(executable)} did not open its DevTools port within 30 s.") + said);
    }

    /// <summary>DevToolsActivePort: the port on the first line, the browser target's path on the second.</summary>
    public static (int Port, string Path)? Parse(string text)
    {
        var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length < 2 || !int.TryParse(lines[0], NumberStyles.None, CultureInfo.InvariantCulture, out var port) || port <= 0 || !lines[1].StartsWith('/')) return null;
        return (port, lines[1]);
    }

    private static async Task<string> ReadShared(string file)
    {
        try
        {
            await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            return await reader.ReadToEndAsync().ConfigureAwait(false);
        }
        catch (IOException)
        {
            return "";
        }
    }

    public ValueTask DisposeAsync()
    {
        Kill(_process);
        _process.Dispose();
        TryDelete(_profile);
        return ValueTask.CompletedTask;
    }

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            process.WaitForExit(5000);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private static void TryDelete(string dir)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
                return;
            }
            catch (IOException) { Thread.Sleep(200); }
            catch (UnauthorizedAccessException) { Thread.Sleep(200); }
        }
    }
}
