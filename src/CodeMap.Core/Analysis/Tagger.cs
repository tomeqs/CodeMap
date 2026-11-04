using CodeMap.Model;
using Microsoft.CodeAnalysis;

namespace CodeMap.Analysis;

/// <summary>Heuristics that recognise well-known roles of C# types (controllers, tests, DbContexts...).</summary>
internal static class Tagger
{
    private static readonly HashSet<string> TestMethodAttributes = new(StringComparer.Ordinal)
    {
        "Fact", "Theory", "Test", "TestCase", "TestCaseSource", "TestMethod", "DataTestMethod", "SkippableFact", "SkippableTheory",
    };

    private static readonly HashSet<string> TestClassAttributes = new(StringComparer.Ordinal) { "TestClass", "TestFixture" };

    private static readonly string[] HandlerInterfaces =
    {
        "IRequestHandler", "INotificationHandler", "ICommandHandler", "IQueryHandler", "IEventHandler", "IConsumer", "IHandleMessages",
        "IStreamRequestHandler", "IPipelineBehavior",
    };

    private static readonly (string Suffix, string Tag)[] NamingConventions =
    {
        ("Repository", Tags.Repository), ("Repo", Tags.Repository),
        ("Service", Tags.Service),
        ("Factory", Tags.Factory),
        ("Options", Tags.Options), ("Settings", Tags.Options), ("Configuration", Tags.Options),
        ("Dto", Tags.Dto), ("DTO", Tags.Dto), ("Request", Tags.Dto), ("Response", Tags.Dto), ("ViewModel", Tags.Dto), ("Model", Tags.Dto),
        ("Validator", Tags.Validator),
        ("Handler", Tags.Handler),
        // Not by name alone: controller and middleware make a type framework-activated (a DI consumer), which needs
        // evidence (a base class, an attribute, the middleware shape) – a CircuitController in a library is neither.
    };

    private static readonly string[] ComponentBases = { "ComponentBase", "LayoutComponentBase", "OwningComponentBase" };

    public static void TagType(INamedTypeSymbol type, GraphNode node, bool isTestProject)
    {
        var baseNames = new List<string>();
        for (var t = type.BaseType; t != null; t = t.BaseType) baseNames.Add(t.Name);
        var interfaceNames = type.AllInterfaces.Select(i => i.Name).ToHashSet(StringComparer.Ordinal);
        var attributes = node.Attributes ?? new List<string>();

        if (baseNames.Contains("ControllerBase") || baseNames.Contains("Controller") || attributes.Contains("ApiController") || attributes.Contains("Controller")) node.AddTag(Tags.Controller);
        var markup = CodeBehindMarkup(type);
        if (baseNames.Contains("PageModel") || markup == ".cshtml") node.AddTag(Tags.Page);
        if (ComponentBases.Any(baseNames.Contains) || markup is ".razor" or ".xaml") node.AddTag(Tags.Component);
        if (baseNames.Any(n => n.EndsWith("DbContext", StringComparison.Ordinal))) node.AddTag(Tags.DbContext);
        if (baseNames.Contains("Exception")) node.AddTag(Tags.Exception);
        if (baseNames.Contains("Attribute")) node.AddTag(Tags.Attribute);
        if (interfaceNames.Contains("IHostedService") || baseNames.Contains("BackgroundService")) node.AddTag(Tags.HostedService);
        if (baseNames.Contains("Hub")) node.AddTag(Tags.Hub);
        if (interfaceNames.Contains("IMiddleware") || HasMiddlewareInvoke(type)) node.AddTag(Tags.Middleware);
        if (HandlerInterfaces.Any(interfaceNames.Contains)) node.AddTag(Tags.Handler);
        if (attributes.Contains("GeneratedCode") || attributes.Contains("CompilerGenerated")) node.AddTag(Tags.Generated);

        if (type.IsStatic && type.GetMembers().OfType<IMethodSymbol>().Any(m => m.IsExtensionMethod)) node.AddTag(Tags.Extensions);
        if (type.GetMembers().OfType<IMethodSymbol>().Any(m => m.IsStatic && m.Name == "Main")) node.AddTag(Tags.EntryPoint);

        var isTestClass = attributes.Any(TestClassAttributes.Contains)
                          || type.GetMembers().OfType<IMethodSymbol>().Any(m => m.GetAttributes().Any(a => TestMethodAttributes.Contains(StripAttribute(a.AttributeClass?.Name))));
        if (isTestClass || (isTestProject && type.Name.EndsWith("Tests", StringComparison.Ordinal))) node.AddTag(Tags.Test);

        if (type.TypeKind is TypeKind.Class or TypeKind.Struct or TypeKind.Interface && !node.HasTag(Tags.Page) && !node.HasTag(Tags.Component))
        {
            var name = type.TypeKind == TypeKind.Interface && type.Name.Length > 1 && type.Name[0] == 'I' && char.IsUpper(type.Name[1])
                ? type.Name[1..]
                : type.Name;
            foreach (var (suffix, tag) in NamingConventions)
            {
                if (name.EndsWith(suffix, StringComparison.Ordinal) && name.Length > suffix.Length)
                {
                    node.AddTag(tag);
                    break;
                }
            }
        }
    }

    public static void TagMember(ISymbol symbol, GraphNode node)
    {
        if (node.Attributes?.Any(TestMethodAttributes.Contains) == true) node.AddTag(Tags.Test);
        if (symbol is IMethodSymbol { IsStatic: true, Name: "Main" }) node.AddTag(Tags.EntryPoint);
    }

    /// <summary>
    /// The markup a type is the code-behind of: ".razor" for X.razor.cs next to X.razor, ".cshtml" and ".xaml" likewise.
    /// Its members are used from that markup, which the analysis does not read.
    /// </summary>
    private static string? CodeBehindMarkup(INamedTypeSymbol type)
    {
        foreach (var location in type.Locations.Where(l => l.IsInSource))
        {
            var path = location.SourceTree?.FilePath;
            if (path == null || !path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) continue;
            var markup = path[..^3];
            var extension = Path.GetExtension(markup).ToLowerInvariant();
            if (extension is ".razor" or ".cshtml" or ".xaml" && File.Exists(markup)) return extension;
        }

        return null;
    }

    private static bool HasMiddlewareInvoke(INamedTypeSymbol type) =>
        type.GetMembers().OfType<IMethodSymbol>().Any(m =>
            m.Name is "Invoke" or "InvokeAsync" && m.Parameters.Length > 0 && m.Parameters[0].Type.Name == "HttpContext");

    private static string StripAttribute(string? name) =>
        name != null && name.EndsWith("Attribute", StringComparison.Ordinal) && name.Length > 9 ? name[..^9] : name ?? "";
}
