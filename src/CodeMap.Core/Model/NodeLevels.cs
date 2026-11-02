namespace CodeMap.Model;

/// <summary>
/// The four levels of the map – project, namespace, type, member – that every language's nodes are shown and
/// measured at, whatever the language calls them. Shared analysis (metrics, git, reports) works by level, not
/// by C# kind, so other languages' kinds fit in.
/// </summary>
public static class NodeLevels
{
    public const string Project = "project";
    public const string Namespace = "namespace";
    public const string Type = "type";
    public const string Member = "member";

    public static readonly IReadOnlyList<string> All = new[] { Project, Namespace, Type, Member };

    /// <summary>The node's own level when it gives a valid one, else the level of its kind.</summary>
    public static string Of(GraphNode node) => node.Level is Project or Namespace or Type or Member ? node.Level : Default(node.Kind);

    /// <summary>
    /// The level a kind has unless a node says otherwise: containers by name, C# members, functions and variables;
    /// anything else (C# types, modules…) is a type.
    /// </summary>
    public static string Default(string kind) => kind switch
    {
        NodeKinds.Project or NodeKinds.Package or NodeKinds.Assembly => Project,
        NodeKinds.Namespace => Namespace,
        NodeKinds.Function or NodeKinds.Variable => Member,
        _ when NodeKinds.IsMember(kind) => Member,
        _ => Type,
    };

    public static bool IsType(GraphNode node) => Of(node) == Type;

    public static bool IsMember(GraphNode node) => Of(node) == Member;
}
