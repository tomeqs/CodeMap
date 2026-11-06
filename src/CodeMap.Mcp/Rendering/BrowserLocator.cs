using System.Runtime.InteropServices;

namespace CodeMap.Mcp.Rendering;

/// <summary>
/// Finds a Chromium-based browser to render the map with: the one given (--browser, CODEMAP_BROWSER), else Edge or
/// Chrome where each system installs them, Chromium on the PATH, and the browsers Playwright downloaded.
/// </summary>
public static class BrowserLocator
{
    public const string EnvironmentVariable = "CODEMAP_BROWSER";

    /// <summary>The browser to use, or null when there is none.</summary>
    public static string? Find(string? given = null) =>
        Candidates(given, Environment.GetEnvironmentVariable, OS(), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))
            .FirstOrDefault(File.Exists);

    /// <summary>Where to look, in order (testable: the environment, the system and the home folder are given).</summary>
    public static IEnumerable<string> Candidates(string? given, Func<string, string?> env, OSPlatform os, string home)
    {
        if (!string.IsNullOrWhiteSpace(given)) yield return given;
        if (env(EnvironmentVariable) is { Length: > 0 } fromEnv) yield return fromEnv;

        if (os == OSPlatform.Windows)
        {
            foreach (var root in new[] { env("ProgramFiles(x86)"), env("ProgramFiles"), env("LOCALAPPDATA") }.Where(r => !string.IsNullOrEmpty(r)))
            {
                yield return Path.Combine(root!, "Microsoft", "Edge", "Application", "msedge.exe");
                yield return Path.Combine(root!, "Google", "Chrome", "Application", "chrome.exe");
            }
        }
        else if (os == OSPlatform.OSX)
        {
            foreach (var apps in new[] { "/Applications", Path.Combine(home, "Applications") })
            {
                yield return Path.Combine(apps, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
                yield return Path.Combine(apps, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge");
                yield return Path.Combine(apps, "Chromium.app", "Contents", "MacOS", "Chromium");
            }
        }
        else
        {
            foreach (var dir in (env("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                foreach (var name in new[] { "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable" })
                {
                    yield return Path.Combine(dir, name);
                }
            }

            yield return "/opt/google/chrome/chrome";
            yield return "/opt/pw-browsers/chromium";
        }

        // Browsers Playwright downloaded (newest first).
        var caches = new[]
        {
            env("PLAYWRIGHT_BROWSERS_PATH"),
            os == OSPlatform.Windows ? Path.Combine(env("LOCALAPPDATA") ?? "", "ms-playwright")
            : os == OSPlatform.OSX ? Path.Combine(home, "Library", "Caches", "ms-playwright")
            : Path.Combine(home, ".cache", "ms-playwright"),
            os == OSPlatform.Linux ? "/opt/pw-browsers" : null,
        };
        foreach (var cache in caches.Where(c => !string.IsNullOrEmpty(c) && Directory.Exists(c)))
        {
            foreach (var dir in Directory.EnumerateDirectories(cache!, "chromium-*").OrderByDescending(d => d, StringComparer.Ordinal))
            {
                yield return os == OSPlatform.Windows ? Path.Combine(dir, "chrome-win", "chrome.exe")
                    : os == OSPlatform.OSX ? Path.Combine(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
                    : Path.Combine(dir, "chrome-linux", "chrome");
            }
        }
    }

    private static OSPlatform OS() =>
        RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? OSPlatform.Windows
        : RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? OSPlatform.OSX
        : OSPlatform.Linux;
}
