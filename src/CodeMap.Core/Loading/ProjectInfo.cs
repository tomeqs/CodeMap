namespace CodeMap.Loading;

/// <summary>What CodeMap needs to know about a C# project to build a compilation for it.</summary>
public sealed class ProjectInfo
{
    public string Name { get; set; } = "";
    public string FilePath { get; set; } = "";
    public string Directory { get; set; } = "";
    public string AssemblyName { get; set; } = "";
    public string? Sdk { get; set; }
    public bool IsSdkStyle { get; set; }
    public string? TargetFramework { get; set; }
    public string OutputType { get; set; } = "Library";
    public bool ImplicitUsings { get; set; }
    public bool AllowUnsafe { get; set; }
    public bool IsTestProject { get; set; }
    public bool UseWindowsDesktop { get; set; }

    /// <summary>The project's &lt;Nullable&gt; setting (enable, warnings, annotations, disable), or null when not set.</summary>
    public string? Nullable { get; set; }

    /// <summary>Warnings the project turns off (&lt;NoWarn&gt;), as compiler ids (CS0168).</summary>
    public HashSet<string> NoWarn { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>True when the project was synthesised from a folder of loose .cs files.</summary>
    public bool IsVirtual { get; set; }

    public List<string> SourceFiles { get; } = new();
    public List<string> ProjectReferences { get; } = new();
    public List<PackageReferenceInfo> PackageReferences { get; } = new();
    public List<string> FrameworkReferences { get; } = new();
    public List<string> DefineConstants { get; } = new();
    public List<string> Usings { get; } = new();
    public List<string> RemovedUsings { get; } = new();

    public override string ToString() => Name;
}

public sealed record PackageReferenceInfo(string Name, string? Version);
