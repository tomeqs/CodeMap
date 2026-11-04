using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.InteropServices;
using Microsoft.CodeAnalysis;

namespace CodeMap.Loading;

/// <summary>
/// Finds the .NET framework assemblies that analyzed code is compiled against. Run as a dotnet tool,
/// codemap uses the shared framework it runs on. A self-contained single-file build has no framework
/// folder of its own, so it looks for an installed .NET (DOTNET_ROOT, dotnet on PATH, the usual install
/// locations) and, on a machine without one, falls back to the runtime bundled inside the executable.
/// </summary>
public static class FrameworkLocator
{
    private const string NetCoreApp = "Microsoft.NETCore.App";

    private static readonly Lazy<string?> Runtime = new(FindRuntimeDirectory);
    private static readonly Lazy<IReadOnlyList<(string Name, MetadataReference Reference)>> Bundled = new(LoadBundledReferences);

    /// <summary>The Microsoft.NETCore.App folder to reference, or null when only the bundled runtime is available.</summary>
    internal static string? RuntimeDirectory => Runtime.Value;

    /// <summary>Framework assemblies taken from the loaded runtime (single-file build, no .NET installed).</summary>
    internal static IReadOnlyList<(string Name, MetadataReference Reference)> BundledReferences => Bundled.Value;

    /// <summary>Where framework references come from, for diagnostics (codemap --version).</summary>
    public static string Describe() =>
        RuntimeDirectory ?? $"the .NET {Environment.Version.ToString(2)} runtime bundled with codemap (no .NET installation found)";

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<(string, int), string?> ForVersion = new();

    /// <summary>
    /// The assemblies of a framework (Microsoft.NETCore.App, Microsoft.AspNetCore.App…) for a .NET major version, so a
    /// net10.0 project sees the .NET 10 API even when codemap runs on .NET 8: an installed runtime of that major
    /// version, else its reference pack (packs/{framework}.Ref/{version}/ref/net{major}.0), else the newest above it.
    /// Null when none is installed (the caller then uses the framework codemap runs on).
    /// </summary>
    internal static string? FindFramework(string framework, int major) =>
        ForVersion.GetOrAdd((framework, major), key => FindFramework(key.Item1, key.Item2, InstallRoots()));

    internal static string? FindFramework(string framework, int major, IEnumerable<string> roots)
    {
        var shared = new List<(string Dir, Version Version, bool Prerelease)>();
        var packs = new List<(string Dir, Version Version, bool Prerelease)>();
        foreach (var root in roots.Distinct(StringComparer.Ordinal))
        {
            var sharedDir = Path.Combine(root, "shared", framework);
            if (Directory.Exists(sharedDir)) shared.AddRange(Versions(sharedDir).Where(v => HasAssemblies(v.Dir)));
            var packDir = Path.Combine(root, "packs", framework + ".Ref");
            if (!Directory.Exists(packDir)) continue;
            foreach (var version in Versions(packDir))
            {
                var refDir = Path.Combine(version.Dir, "ref", $"net{version.Version.Major}.0");
                if (HasAssemblies(refDir)) packs.Add((refDir, version.Version, version.Prerelease));
            }
        }

        static string? Best(IEnumerable<(string Dir, Version Version, bool Prerelease)> candidates) =>
            candidates.OrderByDescending(v => v.Version).ThenBy(v => v.Prerelease).Select(v => v.Dir).FirstOrDefault();

        return Best(shared.Where(v => v.Version.Major == major))
               ?? Best(packs.Where(v => v.Version.Major == major))
               ?? Best(shared.Concat(packs).Where(v => v.Version.Major > major).OrderBy(v => v.Version.Major).Take(1));
    }

    private static bool HasAssemblies(string dir)
    {
        try
        {
            return Directory.Exists(dir) && Directory.EnumerateFiles(dir, "*.dll").Any();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>.NET installations: the one codemap runs on first, then the usual places.</summary>
    private static IEnumerable<string> InstallRoots()
    {
        if (RuntimeDirectory != null && IsSharedFramework(RuntimeDirectory) && Directory.GetParent(RuntimeDirectory)?.Parent?.Parent is { } root) yield return root.FullName;
        foreach (var candidate in DotNetRoots()) yield return candidate;
    }

    /// <summary>Finds shared/{framework}/{version} next to <see cref="RuntimeDirectory"/>, preferring the same major version.</summary>
    internal static string? FindSharedFramework(string framework)
    {
        if (RuntimeDirectory == null) return null;
        var runtimeDir = new DirectoryInfo(RuntimeDirectory);
        var sharedDir = runtimeDir.Parent?.Parent;
        if (sharedDir == null) return null;
        var frameworkDir = Path.Combine(sharedDir.FullName, framework);
        if (!Directory.Exists(frameworkDir)) return null;

        var runtimeMajor = runtimeDir.Name.Split('.')[0];
        var versions = Versions(frameworkDir);
        return versions.FirstOrDefault(v => v.Version.Major.ToString() == runtimeMajor).Dir ?? versions.FirstOrDefault().Dir;
    }

    private static string? FindRuntimeDirectory()
    {
        var location = typeof(object).Assembly.Location; // empty inside a single-file bundle
        var running = string.IsNullOrEmpty(location) ? null : Path.GetDirectoryName(location);
        if (running != null && IsSharedFramework(running)) return running;

        // A self-contained build keeps the runtime next to codemap's own assemblies: an installed .NET is cleaner.
        return FindInstalledRuntime(DotNetRoots()) ?? running;
    }

    private static bool IsSharedFramework(string dir)
    {
        var parent = Directory.GetParent(dir);
        return parent?.Name == NetCoreApp && parent.Parent?.Name == "shared";
    }

    /// <summary>The newest Microsoft.NETCore.App among the given .NET installations.</summary>
    internal static string? FindInstalledRuntime(IEnumerable<string> roots) =>
        roots
            .Select(root => Path.Combine(root, "shared", NetCoreApp))
            .Where(Directory.Exists)
            .SelectMany(Versions)
            .Where(v => File.Exists(Path.Combine(v.Dir, "System.Runtime.dll")))
            .OrderByDescending(v => v.Version)
            .ThenBy(v => v.Prerelease)
            .Select(v => v.Dir)
            .FirstOrDefault();

    private static List<(string Dir, Version Version, bool Prerelease)> Versions(string frameworkDir)
    {
        try
        {
            return Directory.GetDirectories(frameworkDir)
                .Select(d =>
                {
                    var name = Path.GetFileName(d);
                    return (Dir: d, Version: Version.TryParse(name.Split('-')[0], out var v) ? v : new Version(0, 0), Prerelease: name.Contains('-'));
                })
                .OrderByDescending(x => x.Version)
                .ThenBy(x => x.Prerelease)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new();
        }
    }

    /// <summary>Candidate .NET installation folders, most specific first.</summary>
    internal static IEnumerable<string> DotNetRoots()
    {
        var arch = RuntimeInformation.OSArchitecture.ToString().ToUpperInvariant();
        foreach (var variable in new[] { "DOTNET_ROOT_" + arch, "DOTNET_ROOT", "DOTNET_ROOT(x86)" })
        {
            if (Environment.GetEnvironmentVariable(variable) is { Length: > 0 } root) yield return root;
        }

        var executable = OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet";
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var path = Path.Combine(dir.Trim('"'), executable);
            if (!File.Exists(path)) continue;
            string resolved;
            try { resolved = new FileInfo(path).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? path; }
            catch (IOException) { resolved = path; }
            if (Path.GetDirectoryName(resolved) is { } root) yield return root;
        }

        if (!OperatingSystem.IsWindows())
        {
            foreach (var file in new[] { "/etc/dotnet/install_location_" + arch.ToLowerInvariant(), "/etc/dotnet/install_location" })
            {
                string? line = null;
                try { if (File.Exists(file)) line = File.ReadLines(file).FirstOrDefault()?.Trim(); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                if (!string.IsNullOrEmpty(line)) yield return line;
            }
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsWindows())
        {
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet");
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "dotnet");
        }
        else
        {
            yield return "/usr/local/share/dotnet";
            yield return "/usr/share/dotnet";
            yield return "/usr/lib/dotnet";
            yield return "/usr/lib64/dotnet";
            yield return "/opt/dotnet";
        }

        if (!string.IsNullOrEmpty(home)) yield return Path.Combine(home, ".dotnet");
    }

    // ---------------------------------------------------------------- bundled runtime

    /// <summary>
    /// Assemblies a C# project can see, reached from the reference facades (netstandard, mscorlib) and
    /// the ASP.NET Core entry assemblies. A self-contained build ships the whole shared framework, so
    /// every one of them loads from the bundle.
    /// </summary>
    private static readonly string[] BundleSeeds =
    {
        "netstandard", "mscorlib", "System.Runtime", "Microsoft.CSharp", "Microsoft.VisualBasic", "Microsoft.Win32.Registry",
        "System.Collections.Immutable", "System.Diagnostics.DiagnosticSource", "System.Formats.Asn1", "System.Formats.Tar",
        "System.IO.Pipelines", "System.Net.Http.Json", "System.Reflection.Metadata", "System.Text.Json", "System.Threading.Channels",
        "Microsoft.AspNetCore", "Microsoft.AspNetCore.Mvc", "Microsoft.AspNetCore.SignalR", "Microsoft.AspNetCore.Components.Web",
        "Microsoft.AspNetCore.Components.Server", "Microsoft.AspNetCore.Identity", "Microsoft.AspNetCore.OutputCaching",
        "Microsoft.AspNetCore.RateLimiting", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Http",
    };

    private static IReadOnlyList<(string Name, MetadataReference Reference)> LoadBundledReferences()
    {
        var result = new List<(string, MetadataReference)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<string>(BundleSeeds);
        while (queue.Count > 0)
        {
            var name = queue.Dequeue();
            if (!seen.Add(name)) continue;
            Assembly assembly;
            try { assembly = Assembly.Load(new AssemblyName(name)); }
            catch (Exception ex) when (ex is IOException or BadImageFormatException) { continue; }

            if (CreateReference(assembly) is { } reference) result.Add((name, reference));
            foreach (var referenced in assembly.GetReferencedAssemblies())
            {
                if (referenced.Name != null) queue.Enqueue(referenced.Name);
            }
        }

        return result;
    }

    private static unsafe MetadataReference? CreateReference(Assembly assembly)
    {
        if (!assembly.TryGetRawMetadata(out var blob, out var length)) return null;
        // Assemblies in the default load context are never unloaded, so the metadata block stays valid.
        return AssemblyMetadata.Create(ModuleMetadata.CreateFromMetadata((IntPtr)blob, length)).GetReference(display: assembly.GetName().Name);
    }
}
