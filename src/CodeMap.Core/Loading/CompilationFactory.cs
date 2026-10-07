using System.Collections.Concurrent;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace CodeMap.Loading;

/// <summary>
/// Builds Roslyn compilations straight from source files. Framework assemblies come from the
/// running .NET installation, NuGet assemblies from obj/project.assets.json when the project was
/// restored. Anything that cannot be resolved simply stays unresolved – the analysis is best effort.
/// </summary>
public sealed class CompilationFactory
{
    private const string SyntheticUsingsFile = "<codemap-global-usings>.g.cs";

    private static readonly string[] BaseImplicitUsings =
    {
        "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks",
    };

    private static readonly string[] HostingUsings =
    {
        "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging",
    };

    private static readonly string[] WebUsings =
    {
        "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing",
    };

    private readonly ConcurrentDictionary<string, MetadataReference?> _referenceCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<string> _warnings;

    public CompilationFactory(List<string> warnings) => _warnings = warnings;

    public static bool IsSyntheticTree(SyntaxTree tree) => tree.FilePath.EndsWith(SyntheticUsingsFile, StringComparison.Ordinal);

    public CSharpCompilation Create(ProjectInfo project, IEnumerable<MetadataReference> projectReferences, CancellationToken ct = default)
    {
        var parseOptions = new CSharpParseOptions(
            LanguageVersion.Preview,
            DocumentationMode.Parse,
            SourceCodeKind.Regular,
            PreprocessorSymbols(project));

        var trees = new List<SyntaxTree>(project.SourceFiles.Count + 1);
        var lockObj = new object();
        Parallel.ForEach(project.SourceFiles, new ParallelOptions { CancellationToken = ct }, file =>
        {
            try
            {
                using var stream = File.OpenRead(file);
                var text = SourceText.From(stream, throwIfBinaryDetected: false, canBeEmbedded: false);
                var tree = CSharpSyntaxTree.ParseText(text, parseOptions, file, ct);
                lock (lockObj) trees.Add(tree);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
            {
                lock (lockObj) _warnings.Add($"Could not read {file}: {ex.Message}");
            }
        });
        trees.Sort((a, b) => string.CompareOrdinal(a.FilePath, b.FilePath));

        var usings = GlobalUsingsSource(project);
        if (usings != null)
        {
            trees.Add(CSharpSyntaxTree.ParseText(usings, parseOptions, Path.Combine(project.Directory, SyntheticUsingsFile), cancellationToken: ct));
        }

        var references = new List<MetadataReference>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in FrameworkAssemblies(project))
        {
            if (names.Add(Path.GetFileNameWithoutExtension(path)) && GetReference(path) is { } reference) references.Add(reference);
        }

        foreach (var path in PackageAssemblies(project))
        {
            if (names.Add(Path.GetFileNameWithoutExtension(path)) && GetReference(path) is { } reference) references.Add(reference);
        }

        references.AddRange(projectReferences);

        var outputKind = project.OutputType.ToLowerInvariant() switch
        {
            "exe" => OutputKind.ConsoleApplication,
            "winexe" => OutputKind.WindowsApplication,
            _ => OutputKind.DynamicallyLinkedLibrary,
        };

        var options = new CSharpCompilationOptions(
            outputKind,
            nullableContextOptions: NullableContextOptions.Enable,
            allowUnsafe: true,
            concurrentBuild: true,
            reportSuppressedDiagnostics: false);

        return CSharpCompilation.Create(project.AssemblyName, trees, references, options);
    }

    private MetadataReference? GetReference(string path) =>
        _referenceCache.GetOrAdd(path, static p =>
        {
            try
            {
                using var stream = File.OpenRead(p);
                using var pe = new PEReader(stream);
                if (!pe.HasMetadata) return null;
                return MetadataReference.CreateFromFile(p);
            }
            catch
            {
                return null;
            }
        });

    private static IEnumerable<string> PreprocessorSymbols(ProjectInfo project)
    {
        var symbols = new HashSet<string> { "DEBUG", "TRACE" };
        var tfm = project.TargetFramework?.Trim().ToLowerInvariant() ?? "net8.0";
        var match = Regex.Match(tfm, @"^net(?<major>\d+)\.(?<minor>\d+)");
        if (match.Success)
        {
            var major = int.Parse(match.Groups["major"].Value);
            var minor = int.Parse(match.Groups["minor"].Value);
            symbols.UnionWith(new[] { "NET", "NETCOREAPP", $"NET{major}_{minor}" });
            for (var v = 5; v <= major; v++) symbols.Add($"NET{v}_0_OR_GREATER");
            symbols.UnionWith(new[] { "NETCOREAPP1_0_OR_GREATER", "NETCOREAPP2_0_OR_GREATER", "NETCOREAPP3_0_OR_GREATER", "NETCOREAPP3_1_OR_GREATER" });
        }
        else if (tfm.StartsWith("netstandard", StringComparison.Ordinal))
        {
            symbols.Add("NETSTANDARD");
            symbols.Add(tfm.ToUpperInvariant().Replace('.', '_'));
        }
        else if (tfm.StartsWith("netcoreapp", StringComparison.Ordinal))
        {
            symbols.Add("NETCOREAPP");
            symbols.Add(tfm.ToUpperInvariant().Replace('.', '_'));
        }
        else if (tfm.StartsWith("net4", StringComparison.Ordinal) || tfm.StartsWith("v4", StringComparison.Ordinal))
        {
            symbols.Add("NETFRAMEWORK");
            symbols.Add("NET" + new string(tfm.Where(char.IsDigit).ToArray()));
        }

        symbols.UnionWith(project.DefineConstants);
        return symbols;
    }

    private static string? GlobalUsingsSource(ProjectInfo project)
    {
        // The SDK writes the exact list to obj/**/<Project>.GlobalUsings.g.cs – prefer it when the project was built.
        var objDir = Path.Combine(project.Directory, "obj");
        if (!project.IsVirtual && Directory.Exists(objDir))
        {
            var generated = Directory.EnumerateFiles(objDir, "*.GlobalUsings.g.cs", SearchOption.AllDirectories)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            if (generated != null)
            {
                try { return File.ReadAllText(generated); }
                catch (IOException) { }
            }
        }

        var usings = new List<string>();
        if (project.ImplicitUsings)
        {
            usings.AddRange(BaseImplicitUsings);
            var sdk = project.Sdk ?? "";
            if (IsWebSdk(sdk))
            {
                usings.AddRange(WebUsings);
                usings.AddRange(HostingUsings);
            }
            else if (sdk.Contains("Worker", StringComparison.OrdinalIgnoreCase))
            {
                usings.AddRange(HostingUsings);
            }
        }

        usings.AddRange(project.Usings);
        usings.RemoveAll(u => project.RemovedUsings.Contains(u));
        if (usings.Count == 0) return null;
        return string.Join('\n', usings.Distinct().Select(u => $"global using {(u.Contains('=') || u.StartsWith("static ") ? u : "global::" + u)};"));
    }

    private static bool IsWebSdk(string sdk) =>
        sdk.Contains(".Web", StringComparison.OrdinalIgnoreCase) || sdk.Contains("Razor", StringComparison.OrdinalIgnoreCase)
                                                                  || sdk.Contains("Blazor", StringComparison.OrdinalIgnoreCase);

    // ---------------------------------------------------------------- framework assemblies

    private static readonly Lazy<string> RuntimeDirectory = new(() =>
        Path.GetDirectoryName(typeof(object).Assembly.Location) ?? AppContext.BaseDirectory);

    private static IEnumerable<string> FrameworkAssemblies(ProjectInfo project)
    {
        foreach (var file in SafeGetDlls(RuntimeDirectory.Value)) yield return file;

        var frameworks = new HashSet<string>(project.FrameworkReferences, StringComparer.OrdinalIgnoreCase);
        if (IsWebSdk(project.Sdk ?? "")) frameworks.Add("Microsoft.AspNetCore.App");
        if (project.UseWindowsDesktop) frameworks.Add("Microsoft.WindowsDesktop.App");

        foreach (var framework in frameworks)
        {
            var dir = FindSharedFramework(framework);
            if (dir == null) continue;
            foreach (var file in SafeGetDlls(dir)) yield return file;
        }
    }

    /// <summary>Finds dotnet/shared/{framework}/{version} next to the running runtime, preferring the same major version.</summary>
    private static string? FindSharedFramework(string framework)
    {
        var runtimeDir = new DirectoryInfo(RuntimeDirectory.Value);
        var sharedDir = runtimeDir.Parent?.Parent;
        if (sharedDir == null) return null;
        var frameworkDir = Path.Combine(sharedDir.FullName, framework);
        if (!Directory.Exists(frameworkDir)) return null;

        var runtimeMajor = runtimeDir.Name.Split('.')[0];
        var versions = Directory.GetDirectories(frameworkDir)
            .Select(d => (Dir: d, Version: Version.TryParse(Path.GetFileName(d).Split('-')[0], out var v) ? v : new Version(0, 0)))
            .OrderByDescending(x => x.Version)
            .ToList();
        return versions.FirstOrDefault(v => v.Version.Major.ToString() == runtimeMajor).Dir ?? versions.FirstOrDefault().Dir;
    }

    private static IEnumerable<string> SafeGetDlls(string dir)
    {
        try { return Directory.GetFiles(dir, "*.dll"); }
        catch { return Array.Empty<string>(); }
    }

    // ---------------------------------------------------------------- NuGet assemblies

    private IEnumerable<string> PackageAssemblies(ProjectInfo project)
    {
        var assetsFile = Path.Combine(project.Directory, "obj", "project.assets.json");
        if (!File.Exists(assetsFile)) return Array.Empty<string>();

        try
        {
            return ReadAssets(assetsFile, project.TargetFramework);
        }
        catch (Exception ex)
        {
            _warnings.Add($"Could not read {assetsFile}: {ex.Message}");
            return Array.Empty<string>();
        }
    }

    private static List<string> ReadAssets(string assetsFile, string? targetFramework)
    {
        var result = new List<string>();
        using var doc = JsonDocument.Parse(File.ReadAllBytes(assetsFile));
        var root = doc.RootElement;

        var packageFolders = root.TryGetProperty("packageFolders", out var folders)
            ? folders.EnumerateObject().Select(p => p.Name).ToList()
            : new List<string>();
        if (packageFolders.Count == 0) return result;

        if (!root.TryGetProperty("targets", out var targets) || !root.TryGetProperty("libraries", out var libraries)) return result;

        JsonElement? target = null;
        foreach (var t in targets.EnumerateObject())
        {
            if (target == null || (targetFramework != null && t.Name.Contains(targetFramework, StringComparison.OrdinalIgnoreCase)))
            {
                target = t.Value;
            }
        }

        if (target == null) return result;

        foreach (var library in target.Value.EnumerateObject())
        {
            if (!library.Value.TryGetProperty("type", out var type) || type.GetString() != "package") continue;
            if (!library.Value.TryGetProperty("compile", out var compile)) continue;
            if (!libraries.TryGetProperty(library.Name, out var libraryInfo) || !libraryInfo.TryGetProperty("path", out var libPath)) continue;

            foreach (var asset in compile.EnumerateObject())
            {
                if (!asset.Name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) continue;
                foreach (var folder in packageFolders)
                {
                    var full = Path.Combine(folder, libPath.GetString()!, asset.Name);
                    if (File.Exists(full))
                    {
                        result.Add(full);
                        break;
                    }
                }
            }
        }

        return result;
    }
}
