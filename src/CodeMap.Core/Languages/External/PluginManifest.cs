using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using CodeMap.Model;

namespace CodeMap.Languages.External;

/// <summary>
/// codemap-plugin.json: a language CodeMap runs as a separate program (see docs/plugins.md). The program gets the
/// request on stdin and writes the raw graph to a file; CodeMap does the rest as for C#.
/// </summary>
public sealed class PluginManifest
{
    public const int SupportedProtocol = 1;
    public const string FileName = "codemap-plugin.json";

    /// <summary>Id prefixes that belong to CodeMap or C# and no plugin may use.</summary>
    private static readonly string[] ReservedPrefixes = { "project:", "namespace:", "package:", "assembly:", "ext|", "ext:" };

    public int Protocol { get; set; }
    public string Id { get; set; } = "";
    public string IdPrefix { get; set; } = "";
    public string Name { get; set; } = "";
    public string Version { get; set; } = "";

    /// <summary>The program and its arguments; arguments starting with ./ are files of the plugin.</summary>
    public List<string> Command { get; set; } = new();

    public RuntimeSpec? Runtime { get; set; }

    /// <summary>For messages: "a package.json, tsconfig.json, .ts or .js file".</summary>
    public string Inputs { get; set; } = "";

    /// <summary>For messages: "package.json, tsconfig.json or .ts files".</summary>
    public string Markers { get; set; } = "";

    public DetectSpec Detect { get; set; } = new();
    public DisplaySpec? Display { get; set; }
    public UnusedSpec? Unused { get; set; }

    /// <summary>Folder of the manifest (the plugin's files).</summary>
    [JsonIgnore]
    public string Directory { get; set; } = "";

    public sealed class RuntimeSpec
    {
        /// <summary>The program the command starts with, e.g. "node".</summary>
        public string Name { get; set; } = "";
        public int MinVersion { get; set; }

        /// <summary>Environment variable that may name the program's path, e.g. CODEMAP_NODE.</summary>
        public string? EnvVar { get; set; }

        /// <summary>What to tell people who do not have it.</summary>
        public string? Help { get; set; }
    }

    public sealed class DetectSpec
    {
        /// <summary>Project files: a folder with one of these and source files under it holds code of the language.</summary>
        public List<string> Markers { get; set; } = new();

        /// <summary>Source file extensions (".ts").</summary>
        public List<string> Sources { get; set; } = new();

        /// <summary>File name patterns the plugin takes as input ("*.ts", "package.json").</summary>
        public List<string> Inputs { get; set; } = new();

        /// <summary>Folders never searched (node_modules, dist…).</summary>
        public List<string> IgnoreDirs { get; set; } = new();
    }

    public sealed class DisplaySpec
    {
        public LevelLabels? Levels { get; set; }
        public string? External { get; set; }
    }

    public sealed class UnusedSpec
    {
        public List<string>? MemberAccessibility { get; set; }
        public List<string>? TypeAccessibility { get; set; }
        public bool SkipAttributed { get; set; } = true;
        public List<string>? SkipTags { get; set; }
        public List<string>? SkipMemberKinds { get; set; }
        public List<string>? SkipModifiers { get; set; }
        public List<string>? SkipNames { get; set; }
        public string? SkipNamePattern { get; set; }
        public List<string>? SkipParentKinds { get; set; }
        public List<string>? SkipParentTags { get; set; }
        public List<string>? SkipTypeTags { get; set; }

        public UnusedPolicy ToPolicy()
        {
            static IReadOnlySet<string> Set(List<string>? values) => new HashSet<string>(values ?? new List<string>(), StringComparer.Ordinal);
            return new UnusedPolicy
            {
                MemberAccessibility = MemberAccessibility == null ? null : Set(MemberAccessibility),
                TypeAccessibility = TypeAccessibility == null ? null : Set(TypeAccessibility),
                SkipAttributed = SkipAttributed,
                SkipTags = Set(SkipTags),
                SkipMemberKinds = Set(SkipMemberKinds),
                SkipModifiers = Set(SkipModifiers),
                SkipNames = Set(SkipNames),
                SkipNamePattern = string.IsNullOrEmpty(SkipNamePattern) ? null : new Regex(SkipNamePattern, RegexOptions.CultureInvariant),
                SkipParentKinds = Set(SkipParentKinds),
                SkipParentTags = Set(SkipParentTags),
                SkipTypeTags = Set(SkipTypeTags),
            };
        }
    }

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    /// <summary>Reads and checks a manifest; throws <see cref="InvalidDataException"/> with the reason when it cannot be used.</summary>
    public static PluginManifest Load(string path)
    {
        PluginManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<PluginManifest>(File.ReadAllText(path), Json);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException($"{path}: not valid JSON ({ex.Message}).");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new InvalidDataException($"{path}: cannot be read ({ex.Message}).");
        }

        if (manifest == null) throw new InvalidDataException($"{path}: empty.");
        manifest.Directory = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!;
        var problem = manifest.Problem();
        if (problem != null) throw new InvalidDataException($"{path}: {problem}");
        return manifest;
    }

    /// <summary>Why the manifest cannot be used, or null. Explicit nulls in the JSON are problems too (or empty lists).</summary>
    private string? Problem()
    {
        if (Protocol != SupportedProtocol) return $"protocol {Protocol} is not supported (this CodeMap speaks {SupportedProtocol}).";
        if (Id == null || !Regex.IsMatch(Id, "^[a-z][a-z0-9-]*$")) return $"id '{Id}' must be lowercase letters, digits and dashes.";
        if (IdPrefix == null || !Regex.IsMatch(IdPrefix, "^[a-z][a-z0-9-]+:$")) return $"idPrefix '{IdPrefix}' must be lowercase, at least two characters, and end with ':'.";
        if (ReservedPrefixes.Any(p => p.StartsWith(IdPrefix, StringComparison.Ordinal) || IdPrefix.StartsWith(p, StringComparison.Ordinal))) return $"idPrefix '{IdPrefix}' is reserved.";
        if (string.IsNullOrWhiteSpace(Name)) return "a name is needed.";
        if (Command == null || Command.Count == 0 || Command.Any(string.IsNullOrWhiteSpace)) return "a command is needed (a program and its arguments, none empty).";
        if (Runtime != null && string.IsNullOrWhiteSpace(Runtime.Name)) return "runtime needs a name.";
        if (Detect == null) return "detect is needed.";
        Detect.Markers = Clean(Detect.Markers);
        Detect.Sources = Clean(Detect.Sources);
        Detect.Inputs = Clean(Detect.Inputs);
        Detect.IgnoreDirs = Clean(Detect.IgnoreDirs);
        if (Detect.Sources.Count == 0 && Detect.Inputs.Count == 0) return "detect needs sources or inputs.";
        Version ??= "";
        Inputs ??= "";
        Markers ??= "";
        if (Unused?.SkipNamePattern is { Length: > 0 } pattern)
        {
            try
            {
                _ = new Regex(pattern, RegexOptions.CultureInvariant);
            }
            catch (ArgumentException ex)
            {
                return $"unused.skipNamePattern is not a valid regular expression ({ex.Message}).";
            }
        }

        return null;

        static List<string> Clean(List<string>? values) => values?.Where(v => !string.IsNullOrWhiteSpace(v)).ToList() ?? new List<string>();
    }

    public LanguageInfo ToLanguageInfo() => new()
    {
        Id = Id,
        Name = Name,
        Inputs = string.IsNullOrEmpty(Inputs) ? string.Join(", ", Detect.Inputs) + " file" : Inputs,
        InputPatterns = Detect.Inputs,
        Markers = string.IsNullOrEmpty(Markers) ? string.Join(", ", Detect.Markers.Concat(Detect.Sources)) + " files" : Markers,
        Levels = Display?.Levels ?? new LevelLabels(),
        External = Display?.External ?? "external",
        Unused = Unused?.ToPolicy() ?? UnusedPolicy.None,
    };
}
