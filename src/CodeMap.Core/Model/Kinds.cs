namespace CodeMap.Model;

public static class NodeKinds
{
    public const string Project = "project";
    public const string Package = "package";
    public const string Assembly = "assembly";
    public const string Namespace = "namespace";

    public const string Class = "class";
    public const string Interface = "interface";
    public const string Struct = "struct";
    public const string Record = "record";
    public const string RecordStruct = "recordStruct";
    public const string Enum = "enum";
    public const string Delegate = "delegate";

    public const string Method = "method";
    public const string Constructor = "constructor";
    public const string Property = "property";
    public const string Field = "field";
    public const string Event = "event";

    public static readonly IReadOnlySet<string> Types = new HashSet<string>
    {
        Class, Interface, Struct, Record, RecordStruct, Enum, Delegate,
    };

    public static readonly IReadOnlySet<string> Members = new HashSet<string>
    {
        Method, Constructor, Property, Field, Event,
    };

    public static bool IsType(string kind) => Types.Contains(kind);
    public static bool IsMember(string kind) => Members.Contains(kind);
}

public static class EdgeKinds
{
    // Project level
    public const string ProjectReference = "projectReference";
    public const string PackageReference = "packageReference";

    // Type hierarchy
    public const string Inherits = "inherits";
    public const string Implements = "implements";
    public const string Overrides = "overrides";

    // Behaviour (from member bodies)
    public const string Calls = "calls";
    public const string Instantiates = "instantiates";
    public const string Accesses = "accesses";
    public const string Subscribes = "subscribes";
    public const string Throws = "throws";
    public const string Catches = "catches";
    public const string Uses = "uses";

    // Structure (from declarations)
    public const string Holds = "holds";
    public const string Returns = "returns";
    public const string Accepts = "accepts";
    public const string Injects = "injects";
    public const string Extends = "extends";
    public const string DecoratedWith = "decoratedWith";

    /// <summary>Implicit edge derived from <see cref="GraphNode.Parent"/>; only emitted by exporters.</summary>
    public const string Contains = "contains";

    public static readonly IReadOnlyList<string> All = new[]
    {
        ProjectReference, PackageReference, Inherits, Implements, Overrides, Calls, Instantiates,
        Accesses, Subscribes, Throws, Catches, Uses, Holds, Returns, Accepts, Injects, Extends, DecoratedWith,
    };

    /// <summary>Edge kinds that represent a compile-time dependency of the source on the target.</summary>
    public static bool IsDependency(string kind) => kind != Contains;
}

public static class Tags
{
    public const string EntryPoint = "entrypoint";
    public const string Test = "test";
    public const string Controller = "controller";
    public const string DbContext = "dbcontext";
    public const string Exception = "exception";
    public const string Attribute = "attribute";
    public const string HostedService = "hosted-service";
    public const string Middleware = "middleware";
    public const string Hub = "hub";
    public const string Handler = "handler";
    public const string Extensions = "extensions";
    public const string Repository = "repository";
    public const string Service = "service";
    public const string Factory = "factory";
    public const string Options = "options";
    public const string Dto = "dto";
    public const string Validator = "validator";
    public const string Generated = "generated";
    public const string Unused = "unused";
    public const string InCycle = "in-cycle";
    public const string Hotspot = "hotspot";
    public const string TestProject = "test-project";
}
