using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace CodeMap.Loading;

/// <summary>
/// The part of an MSBuild evaluation a map needs, without MSBuild: the properties and items of a project as MSBuild
/// reads them from the nearest Directory.Build.props, Directory.Packages.props, the project file and the nearest
/// Directory.Build.targets, following their imports (Import, ImportGroup, Choose) in document order.
/// <list type="bullet">
/// <item>Paths and values expand $(Property), $(MSBuildThisFileDirectory) and the like, and the usual property
/// functions for finding files above: $([MSBuild]::GetPathOfFileAbove(…)) and GetDirectoryNameOfFileAbove(…).</item>
/// <item>Conditions are evaluated by <see cref="MsBuildCondition"/>. One it cannot read keeps the earlier rule: the
/// property applies, but does not override a value that is already set.</item>
/// <item>Items are kept with the file that declares them; their conditions are evaluated with the final properties,
/// as MSBuild evaluates items after properties.</item>
/// </list>
/// The SDK's own props and targets are not read (Import elements with an Sdk attribute are skipped).
/// </summary>
internal sealed class MsBuildEvaluation
{
    private readonly Dictionary<string, string> _properties = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _globals = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<(XElement Element, string File)> _items = new();
    private readonly HashSet<string> _visited = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, XDocument?> _documents;
    private readonly string _projectDirectory;

    private MsBuildEvaluation(string projectFile, Dictionary<string, XDocument?> documents)
    {
        _documents = documents;
        _projectDirectory = Path.GetDirectoryName(projectFile)!;
    }

    public IReadOnlyDictionary<string, string> Properties => _properties;

    /// <summary>Every file read, the project file included, in the order they were read.</summary>
    public List<string> Files { get; } = new();

    /// <summary>
    /// Evaluates a project. The target framework is found first (it may come from a props file), then everything is
    /// evaluated again with it as a global property, as in the build for that framework.
    /// </summary>
    public static MsBuildEvaluation Evaluate(string projectFile, IReadOnlyDictionary<string, string>? defaults = null)
    {
        var documents = new Dictionary<string, XDocument?>(StringComparer.OrdinalIgnoreCase);
        var first = Run(projectFile, documents, defaults, null);
        var targetFramework = first.Property("TargetFramework")
                              ?? first.Property("TargetFrameworks")?.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
        return targetFramework == null || targetFramework.Contains("$(") ? first : Run(projectFile, documents, defaults, targetFramework);
    }

    private static MsBuildEvaluation Run(string projectFile, Dictionary<string, XDocument?> documents, IReadOnlyDictionary<string, string>? defaults, string? targetFramework)
    {
        var evaluation = new MsBuildEvaluation(projectFile, documents);
        var dir = evaluation._projectDirectory;
        evaluation.SetGlobal("MSBuildProjectDirectory", dir);
        evaluation.SetGlobal("MSBuildProjectFullPath", projectFile);
        evaluation.SetGlobal("MSBuildProjectFile", Path.GetFileName(projectFile));
        evaluation.SetGlobal("MSBuildProjectName", Path.GetFileNameWithoutExtension(projectFile));
        evaluation.SetGlobal("MSBuildProjectExtension", Path.GetExtension(projectFile));
        if (targetFramework != null) evaluation.SetGlobal("TargetFramework", targetFramework);
        foreach (var (key, value) in defaults ?? new Dictionary<string, string>()) evaluation._properties.TryAdd(key, value);

        // Microsoft.Common.props imports the nearest Directory.Build.props, NuGet the nearest Directory.Packages.props;
        // Microsoft.Common.targets the nearest Directory.Build.targets, after the project's own body.
        if (FindAbove(dir, "Directory.Build.props") is { } props) evaluation.Import(props);
        if (FindAbove(dir, "Directory.Packages.props") is { } packages) evaluation.Import(packages);
        evaluation.Import(projectFile);
        if (FindAbove(dir, "Directory.Build.targets") is { } targets) evaluation.Import(targets);
        return evaluation;
    }

    /// <summary>A property's value, trimmed; null when it is not set or empty.</summary>
    public string? Property(string name) =>
        _properties.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    /// <summary>
    /// The items of one type (Compile, PackageReference…) whose conditions do not evaluate to false, with a function
    /// that expands an attribute value of the item as its own file sees it ($(MSBuildThisFileDirectory)…).
    /// </summary>
    public IEnumerable<(XElement Element, Func<string?, string?> Expand)> Items(string name)
    {
        foreach (var (element, file) in _items)
        {
            if (element.Name.LocalName != name) continue;
            if (Condition(element.Attribute("Condition")?.Value, file) == false) continue;
            if (Condition(element.Parent?.Attribute("Condition")?.Value, file) == false) continue;
            yield return (element, value => value == null ? null : Expand(value, file));
        }
    }

    /// <summary>Evaluates a condition as a file sees it; null when it cannot be read.</summary>
    public bool? Condition(string? condition, string file) =>
        MsBuildCondition.Evaluate(condition, name => Lookup(name, file), path => Exists(path));

    private bool Exists(string path)
    {
        // Relative paths in conditions are relative to the project's folder.
        var full = Path.IsPathRooted(path) ? path : Path.Combine(_projectDirectory, path);
        return File.Exists(full) || Directory.Exists(full);
    }

    private void SetGlobal(string name, string value)
    {
        _properties[name] = value;
        _globals.Add(name);
    }

    private void Import(string file)
    {
        file = Path.GetFullPath(file);
        if (!_visited.Add(file)) return;
        if (!_documents.TryGetValue(file, out var doc))
        {
            try
            {
                doc = XDocument.Load(file);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
            {
                doc = null; // a file we cannot read does not stop the analysis
            }

            _documents[file] = doc;
        }

        if (doc?.Root == null) return;
        Files.Add(file);
        Walk(doc.Root, file);
    }

    private void Walk(XElement parent, string file)
    {
        foreach (var element in parent.Elements())
        {
            switch (element.Name.LocalName)
            {
                case "PropertyGroup":
                    var group = Condition(element.Attribute("Condition")?.Value, file);
                    if (group == false) break;
                    foreach (var property in element.Elements())
                    {
                        var condition = Condition(property.Attribute("Condition")?.Value, file);
                        if (condition == false) continue;
                        SetProperty(property.Name.LocalName, Expand(property.Value, file), certain: group == true && condition == true);
                    }

                    break;
                case "ItemGroup":
                    foreach (var item in element.Elements()) _items.Add((item, file));
                    break;
                case "Import":
                    ImportElement(element, file);
                    break;
                case "ImportGroup":
                    if (Condition(element.Attribute("Condition")?.Value, file) == false) break;
                    foreach (var import in element.Elements().Where(e => e.Name.LocalName == "Import")) ImportElement(import, file);
                    break;
                case "Choose":
                    var branch = element.Elements().FirstOrDefault(e => e.Name.LocalName == "When" && Condition(e.Attribute("Condition")?.Value, file) != false)
                                 ?? element.Elements().FirstOrDefault(e => e.Name.LocalName == "Otherwise");
                    if (branch != null) Walk(branch, file);
                    break;
            }
        }
    }

    private void SetProperty(string name, string value, bool certain)
    {
        if (_globals.Contains(name)) return;
        if (!certain && _properties.ContainsKey(name)) return; // a condition we cannot read only fills a gap
        _properties[name] = value;
    }

    private void ImportElement(XElement import, string file)
    {
        if (import.Attribute("Sdk") != null) return; // the SDK's own files: not read
        if (Condition(import.Attribute("Condition")?.Value, file) == false) return;
        var project = import.Attribute("Project")?.Value;
        if (string.IsNullOrWhiteSpace(project)) return;
        var path = Expand(project, file).Trim();
        if (path.Length == 0 || path.Contains("$(")) return;
        var full = Path.Combine(Path.GetDirectoryName(file)!, path.Replace('\\', Path.DirectorySeparatorChar));
        if (!full.Contains('*'))
        {
            if (File.Exists(full)) Import(full);
            return;
        }

        // A wildcard in the file name (build/*.props): every match, in order.
        var directory = Path.GetDirectoryName(full)!;
        if (!Directory.Exists(directory) || directory.Contains('*')) return;
        foreach (var match in Directory.GetFiles(directory, Path.GetFileName(full)).Order(StringComparer.Ordinal)) Import(match);
    }

    private string? Lookup(string name, string file) => name.ToLowerInvariant() switch
    {
        "msbuildthisfiledirectory" => Path.GetDirectoryName(file)! + Path.DirectorySeparatorChar,
        "msbuildthisfile" => Path.GetFileName(file),
        "msbuildthisfilename" => Path.GetFileNameWithoutExtension(file),
        "msbuildthisfilefullpath" => file,
        "msbuildthisfileextension" => Path.GetExtension(file),
        _ => _properties.TryGetValue(name, out var value) ? value : null,
    };

    private static readonly Regex PropertyReference = new(@"\$\((?<name>[A-Za-z_][\w.-]*)\)", RegexOptions.Compiled);

    private static readonly Regex FileAbove = new(
        @"\$\(\[MSBuild\]::(?<function>GetPathOfFileAbove|GetDirectoryNameOfFileAbove)\(\s*'(?<a>[^'$]*)'\s*(,\s*'(?<b>[^'$]*)'\s*)?\)\)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Expands $(Property) (unset ones are empty, as in MSBuild) and the functions that find a file above a folder.
    /// Other property functions stay as written.
    /// </summary>
    public string Expand(string value, string file)
    {
        for (var pass = 0; pass < 8 && value.Contains("$("); pass++)
        {
            var expanded = PropertyReference.Replace(value, m => Lookup(m.Groups["name"].Value, file) ?? "");
            expanded = FileAbove.Replace(expanded, m =>
            {
                var function = m.Groups["function"].Value;
                var getPath = function.Equals("GetPathOfFileAbove", StringComparison.OrdinalIgnoreCase);
                // GetPathOfFileAbove(file, startingDirectory = this file's folder); GetDirectoryNameOfFileAbove(startingDirectory, file)
                var name = getPath ? m.Groups["a"].Value : m.Groups["b"].Value;
                var start = getPath ? (m.Groups["b"].Success ? m.Groups["b"].Value : Path.GetDirectoryName(file)!) : m.Groups["a"].Value;
                if (name.Length == 0 || start.Length == 0) return "";
                var startDirectory = Path.GetFullPath(Path.IsPathRooted(start) ? start : Path.Combine(Path.GetDirectoryName(file)!, start));
                var found = FindAbove(startDirectory, name);
                return found == null ? "" : getPath ? found : Path.GetDirectoryName(found)!;
            });
            if (expanded == value) break;
            value = expanded;
        }

        return value;
    }

    /// <summary>The nearest file with this name in a folder or above it.</summary>
    internal static string? FindAbove(string directory, string name)
    {
        for (var dir = new DirectoryInfo(directory); dir != null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, name);
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }
}
