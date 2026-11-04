using System.Collections.Concurrent;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace CodeMap.Loading;

/// <summary>
/// Builds Roslyn compilations straight from source files. Framework assemblies come from a .NET
/// installation (see <see cref="FrameworkLocator"/>), NuGet assemblies from obj/project.assets.json when the project was
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

        if (FrameworkLocator.RuntimeDirectory == null)
        {
            foreach (var (name, reference) in FrameworkLocator.BundledReferences)
            {
                if (names.Add(name)) references.Add(reference);
            }
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

    private static readonly string[] CoreAppVersions = { "1_0", "1_1", "2_0", "2_1", "2_2", "3_0", "3_1" };
    private static readonly string[] StandardVersions = { "1_0", "1_1", "1_2", "1_3", "1_4", "1_5", "1_6", "2_0", "2_1" };
    private static readonly string[] FrameworkVersions = { "20", "30", "35", "40", "45", "451", "452", "46", "461", "462", "47", "471", "472", "48", "481" };

    /// <summary>The symbols the .NET SDK defines for the target framework (NET8_0, NETSTANDARD2_0_OR_GREATER, NET472...).</summary>
    internal static IEnumerable<string> PreprocessorSymbols(ProjectInfo project)
    {
        var symbols = new HashSet<string> { "DEBUG", "TRACE" };
        var tfm = project.TargetFramework?.Trim().ToLowerInvariant() ?? "net8.0";
        // Every version up to and including the current one, as NAMEx_y_OR_GREATER.
        void OrGreater(string name, string[] versions, string current)
        {
            var last = Array.IndexOf(versions, current);
            for (var i = 0; i <= (last < 0 ? versions.Length - 1 : last); i++) symbols.Add($"{name}{versions[i]}_OR_GREATER");
        }

        var modern = Regex.Match(tfm, @"^net(?<major>\d+)\.(?<minor>\d+)");
        Match framework;
        if (modern.Success && int.Parse(modern.Groups["major"].Value) >= 5)
        {
            var major = int.Parse(modern.Groups["major"].Value);
            var minor = int.Parse(modern.Groups["minor"].Value);
            symbols.UnionWith(new[] { "NET", "NETCOREAPP", $"NET{major}_{minor}" });
            for (var v = 5; v <= major; v++) symbols.Add($"NET{v}_0_OR_GREATER");
            OrGreater("NETCOREAPP", CoreAppVersions, CoreAppVersions[^1]);
        }
        else if (Regex.Match(tfm, @"^netstandard(?<v>\d+\.\d+)$") is { Success: true } standard)
        {
            var version = standard.Groups["v"].Value.Replace('.', '_');
            symbols.UnionWith(new[] { "NETSTANDARD", "NETSTANDARD" + version });
            OrGreater("NETSTANDARD", StandardVersions, version);
        }
        else if (Regex.Match(tfm, @"^netcoreapp(?<v>\d+\.\d+)$") is { Success: true } core)
        {
            var version = core.Groups["v"].Value.Replace('.', '_');
            symbols.UnionWith(new[] { "NETCOREAPP", "NETCOREAPP" + version });
            OrGreater("NETCOREAPP", CoreAppVersions, version);
        }
        else if ((framework = Regex.Match(tfm, @"^(net(?<v>\d{2,3})|v(?<v>\d(\.\d){1,2}))$")).Success)
        {
            var version = framework.Groups["v"].Value.Replace(".", "");
            symbols.UnionWith(new[] { "NETFRAMEWORK", "NET" + version });
            if (Array.IndexOf(FrameworkVersions, version) >= 0) OrGreater("NET", FrameworkVersions, version);
        }

        symbols.UnionWith(project.DefineConstants);
        return symbols;
    }

    private static string? GlobalUsingsSource(ProjectInfo project)
    {
        // The SDK writes the exact list to obj/**/<Project>.GlobalUsings.g.cs – prefer it when the project was built.
        // A build running at the same time may delete obj/ under us, or a folder in it may be unreadable: then
        // fall back to the usings worked out below rather than stopping the analysis.
        var objDir = Path.Combine(project.Directory, "obj");
        if (!project.IsVirtual && Directory.Exists(objDir))
        {
            try
            {
                var generated = Directory.EnumerateFiles(objDir, "*.GlobalUsings.g.cs", SearchOption.AllDirectories)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault();
                if (generated != null) return File.ReadAllText(generated);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
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

    private static IEnumerable<string> FrameworkAssemblies(ProjectInfo project)
    {
        if (FrameworkLocator.RuntimeDirectory is not { } runtimeDirectory) yield break;
        // The framework of the project's own .NET version when it is installed (net10.0 sees the .NET 10 API).
        var major = NetMajor(project.TargetFramework);
        string? Framework(string name) => (major is { } m ? FrameworkLocator.FindFramework(name, m) : null)
                                          ?? (name == "Microsoft.NETCore.App" ? runtimeDirectory : FrameworkLocator.FindSharedFramework(name));

        foreach (var file in SafeGetDlls(Framework("Microsoft.NETCore.App")!)) yield return file;

        var frameworks = new HashSet<string>(project.FrameworkReferences, StringComparer.OrdinalIgnoreCase);
        if (IsWebSdk(project.Sdk ?? "")) frameworks.Add("Microsoft.AspNetCore.App");
        if (project.UseWindowsDesktop) frameworks.Add("Microsoft.WindowsDesktop.App");
        // Not restored: Microsoft.Extensions.* and Microsoft.AspNetCore.* packages are part of the ASP.NET Core shared
        // framework, so its assemblies stand in for them (IServiceCollection, IHostApplicationBuilder resolve in libraries).
        if (!File.Exists(Path.Combine(project.Directory, "obj", "project.assets.json"))
            && project.PackageReferences.Any(p => p.Name.StartsWith("Microsoft.Extensions.", StringComparison.OrdinalIgnoreCase)
                                                 || p.Name.StartsWith("Microsoft.AspNetCore.", StringComparison.OrdinalIgnoreCase)))
        {
            frameworks.Add("Microsoft.AspNetCore.App");
        }

        foreach (var framework in frameworks)
        {
            var dir = Framework(framework);
            if (dir == null) continue;
            foreach (var file in SafeGetDlls(dir)) yield return file;
        }
    }

    /// <summary>The .NET major version of a net5+ target framework (net10.0, net8.0-windows); null for others.</summary>
    internal static int? NetMajor(string? targetFramework)
    {
        var match = Regex.Match(targetFramework?.Trim() ?? "", @"^net(?<major>\d+)\.\d+", RegexOptions.IgnoreCase);
        return match.Success && int.Parse(match.Groups["major"].Value) is var major and >= 5 ? major : null;
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
