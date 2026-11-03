using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.Extensions.FileSystemGlobbing;

namespace CodeMap.Loading;

/// <summary>
/// Discovers C# projects from a solution (.sln/.slnx), a project (.csproj) or a directory and
/// reads them directly from XML. No build, restore or MSBuild installation is required.
/// </summary>
public static class ProjectLoader
{
    private static readonly string[] IgnoredDirectories = { "bin", "obj", "node_modules", "packages", "TestResults" };

    public sealed record LoadResult(string SourcePath, string Root, string Kind, string Name, List<ProjectInfo> Projects, List<string> Warnings);

    public static LoadResult Load(string path)
    {
        var full = Path.GetFullPath(path);
        var warnings = new List<string>();

        if (File.Exists(full))
        {
            var ext = Path.GetExtension(full).ToLowerInvariant();
            var dir = Path.GetDirectoryName(full)!;
            switch (ext)
            {
                case ".sln":
                case ".slnx":
                case ".slnf":
                    var projectFiles = ext switch { ".sln" => ReadSln(full), ".slnx" => ReadSlnx(full), _ => ReadSlnf(full) };
                    var fromSolution = LoadProjects(projectFiles, warnings);
                    return new LoadResult(full, dir, "solution", Path.GetFileNameWithoutExtension(full), fromSolution, warnings);
                case ".csproj":
                    var all = LoadProjects(CollectProjectClosure(full), warnings);
                    return new LoadResult(full, dir, "project", Path.GetFileNameWithoutExtension(full), all, warnings);
                case ".cs":
                    var single = CreateVirtualProject(Path.GetFileNameWithoutExtension(full), dir, new[] { full });
                    return new LoadResult(full, dir, "file", single.Name, new List<ProjectInfo> { single }, warnings);
                default:
                    throw new ArgumentException($"Unsupported input '{path}'. Use a .sln, .slnx, .slnf, .csproj, .cs file or a directory.");
            }
        }

        if (Directory.Exists(full))
        {
            var name = new DirectoryInfo(full).Name;
            var csprojs = EnumerateFiles(full, "*.csproj").ToList();
            if (csprojs.Count > 0)
            {
                return new LoadResult(full, full, "directory", name, LoadProjects(csprojs, warnings), warnings);
            }

            var sources = EnumerateFiles(full, "*.cs").ToList();
            if (sources.Count == 0) throw new ArgumentException($"No .csproj or .cs files found in '{path}'.");
            var project = CreateVirtualProject(name, full, sources);
            return new LoadResult(full, full, "directory", name, new List<ProjectInfo> { project }, warnings);
        }

        throw new FileNotFoundException($"Input '{path}' does not exist.");
    }

    private static List<ProjectInfo> LoadProjects(IEnumerable<string> projectFiles, List<string> warnings)
    {
        var result = new List<ProjectInfo>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in projectFiles)
        {
            if (!seen.Add(file)) continue;
            if (!File.Exists(file))
            {
                warnings.Add($"Project file not found: {file}");
                continue;
            }

            try
            {
                result.Add(ReadProject(file));
            }
            catch (Exception ex)
            {
                warnings.Add($"Could not read project {file}: {ex.Message}");
            }
        }

        // Project names must be unique because they become node ids.
        foreach (var group in result.GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
        {
            var i = 1;
            foreach (var p in group.Skip(1)) p.Name = $"{p.Name}#{++i}";
        }

        return result;
    }

    private static IEnumerable<string> CollectProjectClosure(string root)
    {
        var queue = new Queue<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        queue.Enqueue(Path.GetFullPath(root));
        while (queue.Count > 0)
        {
            var file = queue.Dequeue();
            if (!seen.Add(file) || !File.Exists(file)) continue;
            yield return file;
            XDocument doc;
            try { doc = XDocument.Load(file); }
            catch { continue; }
            foreach (var reference in Items(doc, "ProjectReference"))
            {
                var include = reference.Attribute("Include")?.Value;
                if (string.IsNullOrWhiteSpace(include)) continue;
                queue.Enqueue(ResolvePath(Path.GetDirectoryName(file)!, include));
            }
        }
    }

    internal static IEnumerable<string> ReadSln(string slnPath)
    {
        var dir = Path.GetDirectoryName(slnPath)!;
        var regex = new Regex("^Project\\(\"\\{[^}]+\\}\"\\)\\s*=\\s*\"[^\"]*\",\\s*\"(?<path>[^\"]+)\"", RegexOptions.Multiline);
        foreach (Match match in regex.Matches(File.ReadAllText(slnPath)))
        {
            var relative = match.Groups["path"].Value;
            if (relative.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                yield return ResolvePath(dir, relative);
            }
        }
    }

    internal static IEnumerable<string> ReadSlnx(string slnxPath)
    {
        var dir = Path.GetDirectoryName(slnxPath)!;
        var doc = XDocument.Load(slnxPath);
        foreach (var project in doc.Descendants().Where(e => e.Name.LocalName == "Project"))
        {
            var relative = project.Attribute("Path")?.Value;
            if (relative != null && relative.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                yield return ResolvePath(dir, relative);
            }
        }
    }

    /// <summary>Solution filter: { "solution": { "path": "x.sln", "projects": [ "src\\A\\A.csproj" ] } }.</summary>
    internal static IEnumerable<string> ReadSlnf(string slnfPath)
    {
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(slnfPath));
        var solution = doc.RootElement.GetProperty("solution");
        var solutionPath = solution.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "";
        var solutionDir = Path.GetDirectoryName(ResolvePath(Path.GetDirectoryName(slnfPath)!, solutionPath))!;
        if (!solution.TryGetProperty("projects", out var projects)) return Array.Empty<string>();
        return projects.EnumerateArray()
            .Select(e => e.GetString())
            .Where(path => path != null && path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            .Select(path => ResolvePath(solutionDir, path!))
            .ToList();
    }

    public static ProjectInfo ReadProject(string projectFile)
    {
        var doc = XDocument.Load(projectFile);
        var root = doc.Root ?? throw new InvalidDataException("Empty project file.");
        var dir = Path.GetDirectoryName(projectFile)!;
        var name = Path.GetFileNameWithoutExtension(projectFile);

        var sdk = root.Attribute("Sdk")?.Value
                  ?? root.Elements().FirstOrDefault(e => e.Name.LocalName == "Sdk")?.Attribute("Name")?.Value;
        var properties = ReadDirectoryBuildProps(dir);
        foreach (var (key, value) in ReadProperties(doc)) properties[key] = value;

        string? Prop(string key) => properties.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v) ? v.Trim() : null;
        bool Flag(string key) => string.Equals(Prop(key), "true", StringComparison.OrdinalIgnoreCase)
                                 || string.Equals(Prop(key), "enable", StringComparison.OrdinalIgnoreCase);

        var info = new ProjectInfo
        {
            Name = name,
            FilePath = projectFile,
            Directory = dir,
            Sdk = sdk,
            IsSdkStyle = sdk != null,
            AssemblyName = Substitute(Prop("AssemblyName"), name) ?? name,
            TargetFramework = Prop("TargetFramework") ?? Prop("TargetFrameworks")?.Split(';', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()
                              ?? Prop("TargetFrameworkVersion"),
            OutputType = Prop("OutputType")
                         ?? (sdk != null && (sdk.Contains(".Web", StringComparison.OrdinalIgnoreCase) || sdk.Contains(".Worker", StringComparison.OrdinalIgnoreCase)) ? "Exe" : "Library"),
            ImplicitUsings = Flag("ImplicitUsings"),
            AllowUnsafe = Flag("AllowUnsafeBlocks"),
            UseWindowsDesktop = Flag("UseWPF") || Flag("UseWindowsForms"),
        };

        foreach (var item in Items(doc, "ProjectReference"))
        {
            var include = item.Attribute("Include")?.Value;
            if (!string.IsNullOrWhiteSpace(include)) info.ProjectReferences.Add(ResolvePath(dir, include));
        }

        foreach (var item in Items(doc, "PackageReference"))
        {
            var include = item.Attribute("Include")?.Value;
            if (string.IsNullOrWhiteSpace(include)) continue;
            var version = item.Attribute("Version")?.Value ?? item.Elements().FirstOrDefault(e => e.Name.LocalName == "Version")?.Value;
            info.PackageReferences.Add(new PackageReferenceInfo(include, version));
        }

        foreach (var item in Items(doc, "FrameworkReference"))
        {
            var include = item.Attribute("Include")?.Value;
            if (!string.IsNullOrWhiteSpace(include)) info.FrameworkReferences.Add(include);
        }

        foreach (var item in Items(doc, "Using"))
        {
            var include = item.Attribute("Include")?.Value;
            var remove = item.Attribute("Remove")?.Value;
            if (!string.IsNullOrWhiteSpace(include))
            {
                var alias = item.Attribute("Alias")?.Value;
                var isStatic = string.Equals(item.Attribute("Static")?.Value, "true", StringComparison.OrdinalIgnoreCase);
                info.Usings.Add(alias != null ? $"{alias} = {include}" : isStatic ? $"static {include}" : include);
            }

            if (!string.IsNullOrWhiteSpace(remove)) info.RemovedUsings.Add(remove);
        }

        var defines = Prop("DefineConstants");
        if (defines != null)
        {
            info.DefineConstants.AddRange(defines.Split(';', ',', ' ')
                .Select(d => d.Trim())
                .Where(d => d.Length > 0 && !d.StartsWith("$(", StringComparison.Ordinal)));
        }

        info.IsTestProject = Flag("IsTestProject")
                             || info.PackageReferences.Any(p => p.Name is "Microsoft.NET.Test.Sdk" or "xunit" or "xunit.v3" or "NUnit" or "MSTest.TestFramework" or "TUnit")
                             || (sdk?.StartsWith("MSTest.Sdk", StringComparison.OrdinalIgnoreCase) ?? false);

        // What the conditions on Compile items see: the target framework we compile for, a Debug build, the project's properties.
        string? ConditionProperty(string key) => key.ToLowerInvariant() switch
        {
            "targetframework" => info.TargetFramework,
            "configuration" => Prop("Configuration") ?? "Debug",
            "platform" => Prop("Platform") ?? "AnyCPU",
            "msbuildprojectname" or "projectname" => name,
            _ => Prop(key),
        };
        var defaultItems = !IsFalse(Prop("EnableDefaultItems")) && !IsFalse(Prop("EnableDefaultCompileItems"));
        info.SourceFiles.AddRange(CollectSources(doc, dir, info.IsSdkStyle && defaultItems, ConditionProperty));
        return info;
    }

    private static ProjectInfo CreateVirtualProject(string name, string dir, IEnumerable<string> sources)
    {
        var project = new ProjectInfo
        {
            Name = name,
            FilePath = dir,
            Directory = dir,
            AssemblyName = name,
            IsSdkStyle = true,
            Sdk = "Microsoft.NET.Sdk",
            ImplicitUsings = true,
            IsVirtual = true,
        };
        project.SourceFiles.AddRange(sources);
        return project;
    }

    private static bool IsFalse(string? value) => string.Equals(value, "false", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The Compile items as MSBuild builds them: the SDK's default glob first, then every Compile element in document
    /// order. An Include adds files (minus its Exclude), a Remove takes away what is there so far, so a later Include
    /// wins again. Item and ItemGroup conditions are evaluated where we can (<see cref="MsBuildCondition"/>); one we
    /// can't read applies, as before.
    /// </summary>
    private static IEnumerable<string> CollectSources(XDocument doc, string dir, bool defaultGlob, Func<string, string?> property)
    {
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (defaultGlob)
        {
            foreach (var file in EnumerateFiles(dir, "*.cs", stopAtNestedProjects: true)) files.Add(file);
        }

        // Patterns are expanded on disk the same way for Include, Exclude and Remove (also ../Shared/**).
        HashSet<string> Expand(string? patterns) =>
            string.IsNullOrWhiteSpace(patterns) ? new HashSet<string>() : new HashSet<string>(ExpandPattern(dir, patterns), StringComparer.OrdinalIgnoreCase);

        foreach (var item in Items(doc, "Compile"))
        {
            if (MsBuildCondition.Evaluate(item.Attribute("Condition")?.Value, property) == false) continue;
            if (MsBuildCondition.Evaluate(item.Parent?.Attribute("Condition")?.Value, property) == false) continue;

            var include = Expand(item.Attribute("Include")?.Value);
            include.ExceptWith(Expand(item.Attribute("Exclude")?.Value));
            files.UnionWith(include);
            files.ExceptWith(Expand(item.Attribute("Remove")?.Value));
        }

        return files.OrderBy(f => f, StringComparer.Ordinal);
    }

    private static IEnumerable<string> ExpandPattern(string dir, string includeValue)
    {
        foreach (var raw in includeValue.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var pattern = raw.Trim().Replace('\\', '/');
            if (pattern.Contains("$(")) continue;
            if (!pattern.Contains('*') && !pattern.Contains('?'))
            {
                var file = ResolvePath(dir, pattern);
                if (File.Exists(file)) yield return file;
                continue;
            }

            // Patterns may climb out of the project folder (../Shared/**/*.cs): anchor the matcher there.
            var baseDir = dir;
            while (pattern.StartsWith("../", StringComparison.Ordinal))
            {
                baseDir = Path.GetDirectoryName(baseDir) ?? baseDir;
                pattern = pattern[3..];
            }

            var matcher = new Matcher(StringComparison.OrdinalIgnoreCase);
            matcher.AddInclude(pattern);
            matcher.AddExclude("**/bin/**");
            matcher.AddExclude("**/obj/**");
            foreach (var file in matcher.GetResultsInFullPath(baseDir)) yield return Path.GetFullPath(file);
        }
    }

    /// <summary>Recursively enumerates files, skipping build output and (optionally) nested project folders.</summary>
    internal static IEnumerable<string> EnumerateFiles(string root, string pattern, bool stopAtNestedProjects = false)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            string[] files, subdirs;
            try
            {
                files = Directory.GetFiles(dir, pattern);
                subdirs = Directory.GetDirectories(dir);
            }
            catch (UnauthorizedAccessException) { continue; }
            catch (IOException) { continue; }

            foreach (var file in files.OrderBy(f => f, StringComparer.Ordinal)) yield return file;

            foreach (var sub in subdirs)
            {
                var name = Path.GetFileName(sub);
                if (name.StartsWith('.') || IgnoredDirectories.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
                if (stopAtNestedProjects && HasProject(sub)) continue;
                stack.Push(sub);
            }
        }
    }

    /// <summary>Whether a folder holds a project of its own; an unreadable folder is skipped (it holds no sources we can read).</summary>
    private static bool HasProject(string dir)
    {
        try
        {
            return Directory.EnumerateFiles(dir, "*.csproj").Any();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return true;
        }
    }

    private static Dictionary<string, string> ReadDirectoryBuildProps(string projectDir)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var chain = new List<string>();
        for (var dir = new DirectoryInfo(projectDir); dir != null; dir = dir.Parent)
        {
            var props = Path.Combine(dir.FullName, "Directory.Build.props");
            if (File.Exists(props)) chain.Add(props);
        }

        // Outermost first so that nearer files win, mimicking the usual import chain.
        foreach (var file in Enumerable.Reverse(chain))
        {
            try
            {
                foreach (var (key, value) in ReadProperties(XDocument.Load(file))) result[key] = value;
            }
            catch
            {
                // A broken props file should not stop the analysis.
            }
        }

        return result;
    }

    private static IEnumerable<(string Key, string Value)> ReadProperties(XDocument doc)
    {
        // Unconditional property groups win; conditional ones only fill gaps (we do not evaluate conditions).
        var unconditional = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var conditional = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var group in doc.Descendants().Where(e => e.Name.LocalName == "PropertyGroup"))
        {
            var groupConditional = group.Attribute("Condition") != null;
            foreach (var property in group.Elements())
            {
                var target = groupConditional || property.Attribute("Condition") != null ? conditional : unconditional;
                target[property.Name.LocalName] = property.Value;
            }
        }

        foreach (var (key, value) in conditional)
        {
            if (!unconditional.ContainsKey(key)) yield return (key, value);
        }

        foreach (var (key, value) in unconditional) yield return (key, value);
    }

    private static IEnumerable<XElement> Items(XDocument doc, string itemName) =>
        doc.Descendants().Where(e => e.Name.LocalName == itemName && e.Parent?.Name.LocalName == "ItemGroup");

    private static string? Substitute(string? value, string projectName)
    {
        if (value == null) return null;
        value = value.Replace("$(MSBuildProjectName)", projectName).Replace("$(ProjectName)", projectName);
        return value.Contains("$(") ? null : value;
    }

    private static string ResolvePath(string baseDir, string relative) =>
        Path.GetFullPath(Path.Combine(baseDir, relative.Replace('\\', Path.DirectorySeparatorChar)));
}
