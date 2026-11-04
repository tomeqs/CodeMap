using System.Collections.Concurrent;
using CodeMap.Model;
using Microsoft.CodeAnalysis;

namespace CodeMap.Analysis;

/// <summary>
/// Thread-safe accumulator of nodes and edges. During analysis everything is addressed by an internal
/// key ("assembly|docId" for symbols); <see cref="Build"/> turns keys into the public, stable node ids.
/// </summary>
internal sealed class GraphBuilder
{
    private readonly ConcurrentDictionary<string, NodeDraft> _nodes = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<EdgeKey, int> _edges = new();
    private readonly ConcurrentDictionary<EdgeKey, int> _edgeLines = new(); // first line of calls / instantiations
    private readonly ConcurrentDictionary<string, string> _fallbacks = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _onceFlags = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _assemblyToProject;
    private readonly ConcurrentBag<RegistrationDraft> _registrations = new();
    private readonly ConcurrentDictionary<string, List<DependencyDraft>> _constructorDependencies = new(StringComparer.Ordinal);
    private Dictionary<string, string>? _ids;

    public GraphBuilder(AnalyzerOptions options, string root, Dictionary<string, string> assemblyToProject)
    {
        Options = options;
        Root = root;
        _assemblyToProject = assemblyToProject;
    }

    public AnalyzerOptions Options { get; }
    public string Root { get; }

    private readonly record struct EdgeKey(string Source, string Target, string Kind);

    /// <summary>A DI registration; services are identified by symbol key, or "ext:FullName" for framework types.</summary>
    /// <param name="Position">Offset of the method name in its file: orders registrations on one line.</param>
    /// <param name="IfMissing">TryAdd*: skipped when the service and key are already registered.</param>
    /// <param name="TypeArguments">Of a closed generic service (<c>ILookup&lt;Kind&gt;</c>); null for an open or non-generic one.</param>
    internal sealed record RegistrationDraft(string ServiceIdent, string? ImplementationKey, string Lifetime, string Kind, string? Key, string? SourceKey, SourceLocation Location, int Position, bool IfMissing, IReadOnlyList<string>? TypeArguments = null);

    /// <summary>One constructor parameter of a type, as a DI container would see it.</summary>
    /// <param name="Key">[FromKeyedServices(key)]: only a registration under that key matches.</param>
    /// <param name="TypeArguments">Of a closed generic service; registrations with the same ones match first.</param>
    internal sealed record DependencyDraft(string ServiceIdent, bool Many, bool Optional, string? Key = null, IReadOnlyList<string>? TypeArguments = null)
    {
        public bool External => ServiceIdent.StartsWith("ext:", StringComparison.Ordinal);
    }

    public IReadOnlyCollection<RegistrationDraft> Registrations => _registrations;
    public IReadOnlyDictionary<string, List<DependencyDraft>> ConstructorDependencies => _constructorDependencies;

    /// <summary>
    /// Identity of a service type for DI matching. Generic types match on their definition (their arguments are
    /// <see cref="TypeArgumentsOf"/>). A type the compiler could not resolve (a package that was never restored) is
    /// known by its name as written, so a registration and a constructor parameter of it still match.
    /// </summary>
    public string? ServiceIdent(ITypeSymbol? type, string? fallbackName = null)
    {
        if (type == null) return fallbackName != null ? "ext:" + fallbackName : null;
        if (type is not INamedTypeSymbol named || named.TypeKind == TypeKind.TypeParameter) return null;
        if (named.TypeKind == TypeKind.Error) return named.Name.Length == 0 ? null : "ext:" + ErrorTypeName(named);
        if (named.OriginalDefinition.SpecialType != SpecialType.None) return null;
        var definition = (INamedTypeSymbol)named.OriginalDefinition;
        return IsInternal(definition) ? SymbolKey(definition) : "ext:" + definition.ToDisplayString(SymbolFormats.FullType);
    }

    /// <summary>An unresolved type's name as written, with its arity in place of its arguments: <c>MediatR.IRequestHandler&lt;,&gt;</c>.</summary>
    private static string ErrorTypeName(INamedTypeSymbol type)
    {
        var ns = type.ContainingType != null ? ErrorTypeName(type.ContainingType) + "."
            : type.ContainingNamespace is { IsGlobalNamespace: false } containing ? containing.ToDisplayString() + "." : "";
        return ns + type.Name + (type.Arity > 0 ? "<" + new string(',', type.Arity - 1) + ">" : "");
    }

    /// <summary>
    /// The type arguments of a closed generic service as text, the same for a registration and a request
    /// (<c>["Shop.Kind"]</c> for <c>ILookup&lt;Kind&gt;</c>); null for a non-generic service and an open one
    /// (<c>typeof(IRepository&lt;&gt;)</c>, or a type parameter of the consumer).
    /// </summary>
    public static IReadOnlyList<string>? TypeArgumentsOf(ITypeSymbol? type)
    {
        if (type is not INamedTypeSymbol { IsGenericType: true } named || named.IsUnboundGenericType) return null;
        static bool Open(ITypeSymbol t) => t switch
        {
            ITypeParameterSymbol => true,
            IArrayTypeSymbol array => Open(array.ElementType),
            INamedTypeSymbol generic => generic.TypeArguments.Any(Open),
            _ => false,
        };
        return named.TypeArguments.Any(Open) ? null : named.TypeArguments.Select(t => t.ToDisplayString(SymbolFormats.FullType)).ToArray();
    }

    public void AddRegistration(RegistrationCandidate candidate, string? sourceKey, SourceLocation location, int position)
    {
        var service = ServiceIdent(candidate.Service, candidate.ServiceName);
        if (service == null) return;
        string? implementation = null;
        if (candidate.Implementation is INamedTypeSymbol impl && impl.TypeKind != TypeKind.Error && IsInternal(impl.OriginalDefinition))
        {
            implementation = SymbolKey(impl.OriginalDefinition);
        }

        _registrations.Add(new RegistrationDraft(service, implementation, candidate.Lifetime, candidate.Kind, candidate.Key, sourceKey, location, position, candidate.IfMissing, TypeArgumentsOf(candidate.Service)));
    }

    public void SetConstructorDependencies(string typeKey, List<DependencyDraft> dependencies) => _constructorDependencies[typeKey] = dependencies;

    /// <summary>Public id of an internal key; only valid after <see cref="Build"/>.</summary>
    public string? IdOf(string? key) => key != null && _ids != null && _ids.TryGetValue(key, out var id) ? id : null;

    internal sealed class NodeDraft
    {
        public NodeDraft(GraphNode node) => Node = node;
        public GraphNode Node { get; }
        public List<SourceLocation> Locations { get; } = new();
        public int Loc { get; set; }
    }

    // ------------------------------------------------------------------ nodes

    public NodeDraft GetOrAddNode(string key, Func<GraphNode> factory) =>
        _nodes.GetOrAdd(key, k =>
        {
            var node = factory();
            node.Id = k;
            return new NodeDraft(node);
        });

    public bool TryGetNode(string key, out NodeDraft draft) => _nodes.TryGetValue(key, out draft!);

    public void AddLocation(NodeDraft draft, SourceLocation location)
    {
        lock (draft)
        {
            draft.Locations.Add(location);
            draft.Loc += location.EndLine - location.Line + 1;
        }
    }

    /// <summary>Returns true only the first time it is called for the given flag (used for partial types).</summary>
    public bool Once(string flag) => _onceFlags.TryAdd(flag, 0);

    public string ProjectKey(string projectName) => "project:" + projectName;

    public string EnsureNamespace(string projectName, INamespaceSymbol? ns)
    {
        var name = ns == null || ns.IsGlobalNamespace ? "(global)" : ns.ToDisplayString(SymbolFormats.Namespace);
        var key = $"namespace:{projectName}/{name}";
        GetOrAddNode(key, () => new GraphNode
        {
            Kind = NodeKinds.Namespace,
            Name = name,
            FullName = name,
            Parent = ProjectKey(projectName),
            Project = ProjectKey(projectName),
            Namespace = name,
        });
        return key;
    }

    // ------------------------------------------------------------------ symbol keys

    public bool IsInternal(ISymbol symbol) =>
        symbol.ContainingAssembly is { } assembly && _assemblyToProject.ContainsKey(assembly.Name);

    public string? ProjectOf(ISymbol symbol) =>
        symbol.ContainingAssembly is { } assembly && _assemblyToProject.TryGetValue(assembly.Name, out var project) ? project : null;

    /// <summary>Key of a symbol declared in the analyzed code.</summary>
    public static string? SymbolKey(ISymbol symbol)
    {
        var docId = symbol.GetDocumentationCommentId();
        if (string.IsNullOrEmpty(docId) || symbol.ContainingAssembly == null) return null;
        return symbol.ContainingAssembly.Name + "|" + docId;
    }

    public static ISymbol Normalize(ISymbol symbol)
    {
        switch (symbol)
        {
            case IMethodSymbol method:
                method = method.ReducedFrom ?? method;
                method = method.PartialDefinitionPart ?? method;
                if (method.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet && method.AssociatedSymbol != null)
                    return Normalize(method.AssociatedSymbol);
                if (method.MethodKind is MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.EventRaise && method.AssociatedSymbol != null)
                    return Normalize(method.AssociatedSymbol);
                return method.OriginalDefinition;
            case IFieldSymbol { AssociatedSymbol: { } associated }:
                return Normalize(associated);
            default:
                return symbol.OriginalDefinition;
        }
    }

    /// <summary>Unwraps arrays, pointers and nullable value types; returns null for types that are never interesting.</summary>
    public static INamedTypeSymbol? UnwrapType(ITypeSymbol? type)
    {
        while (true)
        {
            switch (type)
            {
                case IArrayTypeSymbol array:
                    type = array.ElementType;
                    continue;
                case IPointerTypeSymbol pointer:
                    type = pointer.PointedAtType;
                    continue;
                case INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable:
                    type = nullable.TypeArguments[0];
                    continue;
                case INamedTypeSymbol named:
                    if (named.TypeKind is TypeKind.Error or TypeKind.Dynamic) return null;
                    if (named.IsTupleType || named.IsAnonymousType) return null;
                    var special = named.OriginalDefinition.SpecialType;
                    if (special is > SpecialType.None and <= SpecialType.System_Array or SpecialType.System_DateTime) return null;
                    return (INamedTypeSymbol)named.OriginalDefinition;
                default:
                    return null;
            }
        }
    }

    /// <summary>Key for a type reference: internal type, external type node (if enabled) or null.</summary>
    public string? TypeKey(ITypeSymbol? typeSymbol)
    {
        var type = UnwrapType(typeSymbol);
        if (type == null) return null;
        if (IsInternal(type)) return SymbolKey(type);
        return Options.IncludeExternal ? ExternalTypeKey(type) : null;
    }

    /// <summary>Key for a member reference. External members are rolled up to their (external) type.</summary>
    public string? MemberKey(ISymbol symbol)
    {
        symbol = Normalize(symbol);
        var containingType = symbol.ContainingType;
        if (containingType == null || containingType.IsAnonymousType || containingType.IsTupleType) return null;

        if (!IsInternal(symbol))
        {
            return Options.IncludeExternal ? TypeKey(containingType) : null;
        }

        var key = SymbolKey(symbol);
        if (key == null) return null;
        // Implicitly declared members (record Equals, default ctors, enum members...) have no node: fall back to the type.
        var fallback = SymbolKey(containingType.OriginalDefinition);
        if (fallback != null) _fallbacks.TryAdd(key, fallback);
        return key;
    }

    private string? ExternalTypeKey(INamedTypeSymbol type)
    {
        var docId = type.GetDocumentationCommentId();
        if (docId == null) return null;
        var assembly = type.ContainingAssembly?.Name ?? "unknown";
        var key = "ext|" + assembly + "|" + docId;
        GetOrAddNode(key, () =>
        {
            var assemblyKey = "assembly:" + assembly;
            GetOrAddNode(assemblyKey, () => new GraphNode { Kind = NodeKinds.Assembly, Name = assembly, FullName = assembly, External = true });
            return new GraphNode
            {
                Kind = TypeAnalyzer.KindOf(type),
                Name = type.ToDisplayString(SymbolFormats.ShortType),
                FullName = type.ToDisplayString(SymbolFormats.FullType),
                Namespace = type.ContainingNamespace?.IsGlobalNamespace == false ? type.ContainingNamespace.ToDisplayString(SymbolFormats.Namespace) : null,
                Parent = assemblyKey,
                External = true,
            };
        });
        return key;
    }

    // ------------------------------------------------------------------ edges

    public void AddEdge(string? source, string? target, string kind, int line = 0)
    {
        if (source == null || target == null) return;
        if (source == target && kind != EdgeKinds.Calls) return;
        var key = new EdgeKey(source, target, kind);
        _edges.AddOrUpdate(key, 1, static (_, w) => w + 1);
        if (line > 0) _edgeLines.AddOrUpdate(key, line, (_, existing) => Math.Min(existing, line));
    }

    // ------------------------------------------------------------------ build

    public CodeGraph Build(IReadOnlyList<string> projectOrder)
    {
        var graph = new CodeGraph();
        var ids = AssignIds(projectOrder);
        _ids = ids;

        foreach (var (key, draft) in _nodes)
        {
            var node = draft.Node;
            node.Id = ids[key];
            if (node.Parent != null) node.Parent = ids.TryGetValue(node.Parent, out var parentId) ? parentId : null;

            if (draft.Locations.Count > 0)
            {
                var ordered = draft.Locations
                    .OrderByDescending(l => l.EndLine - l.Line)
                    .ThenBy(l => l.File, StringComparer.Ordinal)
                    .ThenBy(l => l.Line)
                    .ToList();
                node.Location = ordered[0];
                node.ExtraLocations = ordered.Count > 1 ? ordered.Skip(1).OrderBy(l => l.File, StringComparer.Ordinal).ToList() : null;
                if (NodeKinds.IsType(node.Kind) || NodeKinds.IsMember(node.Kind)) node.SetMetric("loc", draft.Loc);
            }

            graph.Nodes.Add(node);
        }

        var edges = new Dictionary<EdgeKey, (int Weight, int Line)>();
        foreach (var (edge, weight) in _edges)
        {
            if (!ids.TryGetValue(edge.Source, out var source)) continue;
            var target = Resolve(edge.Target, ids);
            if (target == null) continue;
            if (source == target && (edge.Kind != EdgeKinds.Calls || edge.Source != edge.Target)) continue;
            var key = new EdgeKey(source, target, edge.Kind);
            var line = _edgeLines.GetValueOrDefault(edge);
            edges[key] = edges.TryGetValue(key, out var existing)
                ? (existing.Weight + weight, existing.Line == 0 ? line : line == 0 ? existing.Line : Math.Min(existing.Line, line))
                : (weight, line);
        }

        graph.Edges.AddRange(edges.Select(e => new GraphEdge { Source = e.Key.Source, Target = e.Key.Target, Kind = e.Key.Kind, Weight = e.Value.Weight, Line = e.Value.Line }));

        graph.Nodes.Sort((a, b) =>
        {
            var c = NodeRank(a).CompareTo(NodeRank(b));
            return c != 0 ? c : string.CompareOrdinal(a.Id, b.Id);
        });
        graph.Edges.Sort((a, b) =>
        {
            var c = string.CompareOrdinal(a.Source, b.Source);
            if (c == 0) c = string.CompareOrdinal(a.Kind, b.Kind);
            return c != 0 ? c : string.CompareOrdinal(a.Target, b.Target);
        });
        return graph;
    }

    private string? Resolve(string key, Dictionary<string, string> ids)
    {
        for (var i = 0; i < 4; i++)
        {
            if (ids.TryGetValue(key, out var id)) return id;
            if (!_fallbacks.TryGetValue(key, out var fallback)) return null;
            key = fallback;
        }

        return null;
    }

    private Dictionary<string, string> AssignIds(IReadOnlyList<string> projectOrder)
    {
        var ids = new Dictionary<string, string>(StringComparer.Ordinal);
        var taken = new HashSet<string>(StringComparer.Ordinal);
        var assemblyRank = projectOrder
            .Select((project, index) => (project, index))
            .ToDictionary(x => x.project, x => x.index);

        int Rank(string assembly) =>
            _assemblyToProject.TryGetValue(assembly, out var project) && assemblyRank.TryGetValue(project, out var r) ? r : int.MaxValue;

        // Non-symbol keys are already ids.
        foreach (var key in _nodes.Keys.Where(k => !k.Contains('|')))
        {
            ids[key] = key;
            taken.Add(key);
        }

        // Internal symbols first (in project order), so they win the plain doc-id; then external ones.
        var symbolKeys = _nodes.Keys
            .Where(k => k.Contains('|'))
            .Select(k =>
            {
                var external = k.StartsWith("ext|", StringComparison.Ordinal);
                var rest = external ? k[4..] : k;
                var bar = rest.IndexOf('|');
                return (Key: k, External: external, Assembly: rest[..bar], DocId: rest[(bar + 1)..]);
            })
            .OrderBy(x => x.External)
            .ThenBy(x => Rank(x.Assembly))
            .ThenBy(x => x.Key, StringComparer.Ordinal);

        foreach (var item in symbolKeys)
        {
            var id = taken.Contains(item.DocId) ? item.DocId + "@" + item.Assembly : item.DocId;
            ids[item.Key] = id;
            taken.Add(id);
        }

        return ids;
    }

    private static int NodeRank(GraphNode node) => node.Kind switch
    {
        NodeKinds.Project => 0,
        NodeKinds.Namespace => 1,
        _ when NodeKinds.IsType(node.Kind) => node.External ? 6 : 2,
        _ when NodeKinds.IsMember(node.Kind) => 3,
        NodeKinds.Package => 4,
        NodeKinds.Assembly => 5,
        _ => 7,
    };
}
