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

    public static string Of(GraphNode node) => Default(node.Kind);

    /// <summary>The level a kind has unless a node says otherwise: containers by name, C# members, anything else is a type.</summary>
    public static string Default(string kind) => kind switch
    {
        NodeKinds.Project or NodeKinds.Package or NodeKinds.Assembly => Project,
        NodeKinds.Namespace => Namespace,
        _ when NodeKinds.IsMember(kind) => Member,
        _ => Type,
    };

    public static bool IsType(GraphNode node) => Of(node) == Type;

    public static bool IsMember(GraphNode node) => Of(node) == Member;
}
