using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Insights;

/// <summary>A change to try on a map without touching the code. Nodes are given by id.</summary>
public abstract record SimOp
{
    /// <summary>The operation's name as the MCP tool takes it (moveType…).</summary>
    public abstract string Op { get; }
}

/// <summary>Moves a type (with its members) into another namespace (folder).</summary>
public sealed record MoveTypeOp(string Type, string To) : SimOp { public override string Op => "moveType"; }

/// <summary>Moves a member into another type (or class).</summary>
public sealed record MoveMemberOp(string Member, string To) : SimOp { public override string Op => "moveMember"; }

/// <summary>Moves a namespace (with all it holds) into another project.</summary>
public sealed record MoveNamespaceOp(string Namespace, string ToProject) : SimOp { public override string Op => "moveNamespace"; }

/// <summary>Moves everything in one namespace into another and removes the first.</summary>
public sealed record MergeNamespacesOp(string From, string Into) : SimOp { public override string Op => "mergeNamespaces"; }

/// <summary>Drops the references from everything in one node to everything in another (optionally of some kinds).</summary>
public sealed record RemoveDependencyOp(string From, string To, IReadOnlyList<string>? Kinds = null) : SimOp { public override string Op => "removeDependency"; }

/// <summary>
/// Dependency inversion: for each type in <c>To</c> that <c>From</c> uses, an interface in <c>InterfaceIn</c> (default:
/// beside the first user in <c>From</c>), implemented by the type; <c>From</c> then uses the interfaces, and the DI container
/// injects the type for them.
/// </summary>
public sealed record InvertDependencyOp(string From, string To, string? InterfaceIn = null) : SimOp { public override string Op => "invertDependency"; }

/// <summary>An interface with members of a type (default: those used from outside it); its users then use the interface.</summary>
public sealed record ExtractInterfaceOp(string Type, string? Name = null, IReadOnlyList<string>? Members = null, string? In = null) : SimOp { public override string Op => "extractInterface"; }

/// <summary>New types beside a type, each taking some of its members.</summary>
public sealed record SplitTypeOp(string Type, IReadOnlyList<SplitPart> Parts) : SimOp { public override string Op => "splitType"; }

public sealed record SplitPart(string Name, IReadOnlyList<string> Members);

/// <summary>Removes a node with everything inside it and every reference to it (dead code).</summary>
public sealed record RemoveNodeOp(string Node) : SimOp { public override string Op => "removeNode"; }

/// <summary>Gives the DI registrations of a service or implementation another lifetime.</summary>
public sealed record SetLifetimeOp(string Service, string Lifetime) : SimOp { public override string Op => "setLifetime"; }

/// <summary>An operation that cannot be applied; the whole batch is rejected.</summary>
public sealed class SimulationException(string message) : Exception(message);

/// <summary>A simulated map: the changed raw graph, the map derived from it, and what was done.</summary>
public sealed class SimulationResult
{
    public required RawGraph Raw { get; init; }
    public required CodeGraph Graph { get; init; }

    /// <summary>One line per operation: what it did.</summary>
    public required List<string> Applied { get; init; }

    /// <summary>The ids new nodes would most likely get once the code is changed for real (C#), by simulated id.</summary>
    public required Dictionary<string, string> PredictedIds { get; init; }

    /// <summary>What the simulation could not model (inheritance that cannot be inverted…).</summary>
    public required List<string> Notes { get; init; }
}

/// <summary>
/// What-if: applies operations to a copy of a raw graph and derives the map again, so the effect of a refactoring
/// (cycles, layers, coupling, findings, the score) can be seen before anyone edits code. Ids of existing nodes never
/// change; new nodes get the id the real code would give them when that can be predicted (C#), else a <c>sim:</c> id,
/// and are tagged <c>simulated</c>. A batch is applied as a whole or not at all.
/// </summary>
public static class Simulator
{
    public const string SimulatedTag = "simulated";
    public const string MovedTag = "moved";

    public static readonly IReadOnlyList<string> Lifetimes = new[] { Tags.DiSingleton, Tags.DiScoped, Tags.DiTransient };

    public static SimulationResult Run(RawGraph raw, IReadOnlyList<SimOp> operations, CodeGraph? gitFrom = null)
    {
        if (operations.Count == 0) throw new SimulationException("No operations.");
        var graph = raw.Graph.Clone();
        var state = new State(graph, raw);
        for (var i = 0; i < operations.Count; i++)
        {
            try
            {
                state.Applied.Add(Apply(state, operations[i]));
            }
            catch (SimulationException ex)
            {
                throw new SimulationException($"Operation {i + 1} ({operations[i].Op}): {ex.Message}");
            }
        }

        // Diagnostics of removed code go with it.
        graph.Analysis.Diagnostics?.RemoveAll(d => d.Node != null && !state.Ids.Contains(d.Node));
        var changed = raw.With(graph);
        var derived = GraphPipeline.Derive(changed, new DeriveOptions { GitFrom = gitFrom });
        return new SimulationResult { Raw = changed, Graph = derived, Applied = state.Applied, PredictedIds = state.Predicted, Notes = state.Notes };
    }

    /// <summary>The graph being changed, with look-ups kept up to date.</summary>
    private sealed class State
    {
        public State(CodeGraph graph, RawGraph raw)
        {
            Graph = graph;
            Raw = raw;
            ById = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        }

        public CodeGraph Graph { get; }
        public RawGraph Raw { get; }
        public Dictionary<string, GraphNode> ById { get; }
        public HashSet<string> Ids => ById.Keys.ToHashSet(StringComparer.Ordinal);
        public List<string> Applied { get; } = new();
        public List<string> Notes { get; } = new();
        public Dictionary<string, string> Predicted { get; } = new(StringComparer.Ordinal);

        public GraphNode Node(string id, string role) => ById.GetValueOrDefault(id) ?? throw new SimulationException($"no node '{id}' ({role}).");

        public IEnumerable<GraphNode> Children(string id) => Graph.Nodes.Where(n => n.Parent == id);

        public IEnumerable<GraphNode> Descendants(string id)
        {
            var pending = new Stack<string>(new[] { id });
            while (pending.Count > 0)
            {
                foreach (var child in Children(pending.Pop()))
                {
                    yield return child;
                    pending.Push(child.Id);
                }
            }
        }

        public HashSet<string> Within(string id) => Descendants(id).Select(n => n.Id).Append(id).ToHashSet(StringComparer.Ordinal);

        public string? Language(GraphNode node)
        {
            var project = node.Kind == NodeKinds.Project ? node : node.Project != null ? ById.GetValueOrDefault(node.Project) : null;
            return project?.Language ?? (project != null ? Raw.LanguageOfProject.GetValueOrDefault(project.Id)?.Id : null);
        }

        public string? NamespaceOf(GraphNode node)
        {
            for (var current = node; current != null; current = current.Parent != null ? ById.GetValueOrDefault(current.Parent) : null)
            {
                if (current.Kind == NodeKinds.Namespace) return current.Id;
            }

            return null;
        }

        public GraphNode Add(GraphNode node)
        {
            var id = node.Id;
            for (var n = 2; ById.ContainsKey(id); n++) id = $"{node.Id}~{n}";
            node.Id = id;
            node.AddTag(SimulatedTag);
            Graph.Nodes.Add(node);
            ById[id] = node;
            return node;
        }

        public void Remove(IEnumerable<string> ids)
        {
            var set = ids.ToHashSet(StringComparer.Ordinal);
            Graph.Nodes.RemoveAll(n => set.Contains(n.Id));
            foreach (var id in set) ById.Remove(id);
            Graph.Edges.RemoveAll(e => set.Contains(e.Source) || set.Contains(e.Target));
            if (Graph.Analysis.Di is { } di)
            {
                di.Registrations.RemoveAll(r => set.Contains(r.Service) || r.Implementation != null && set.Contains(r.Implementation));
                foreach (var r in di.Registrations.Where(r => r.RegisteredIn != null && set.Contains(r.RegisteredIn))) r.RegisteredIn = null;
                di.Dependencies.RemoveAll(d => set.Contains(d.Consumer) || set.Contains(d.Service));
            }
        }

        /// <summary>A node and what it holds belong to another project from now on.</summary>
        public void Reproject(GraphNode node, string? project)
        {
            node.Project = project;
            foreach (var child in Descendants(node.Id)) child.Project = project;
        }
    }

    private static string Apply(State s, SimOp op) => op switch
    {
        MoveTypeOp o => MoveType(s, o),
        MoveMemberOp o => MoveMember(s, o),
        MoveNamespaceOp o => MoveNamespace(s, o),
        MergeNamespacesOp o => MergeNamespaces(s, o),
        RemoveDependencyOp o => RemoveDependency(s, o),
        InvertDependencyOp o => InvertDependency(s, o),
        ExtractInterfaceOp o => ExtractInterface(s, o),
        SplitTypeOp o => SplitType(s, o),
        RemoveNodeOp o => RemoveNode(s, o),
        SetLifetimeOp o => SetLifetime(s, o),
        _ => throw new SimulationException($"unknown operation {op.Op}."),
    };

    private static void SameLanguage(State s, GraphNode a, GraphNode b)
    {
        var (x, y) = (s.Language(a), s.Language(b));
        if (x != null && y != null && x != y) throw new SimulationException($"{a.Id} is {x} and {b.Id} is {y}: code cannot move between languages.");
    }

    private static string MoveType(State s, MoveTypeOp o)
    {
        var type = s.Node(o.Type, "type");
        var to = s.Node(o.To, "namespace");
        if (!NodeLevels.IsType(type)) throw new SimulationException($"{type.Id} is not a type.");
        if (to.Kind != NodeKinds.Namespace) throw new SimulationException($"{to.Id} is not a namespace.");
        if (type.Parent != null && s.ById.TryGetValue(type.Parent, out var parent) && NodeLevels.IsType(parent)) throw new SimulationException($"{type.Id} is nested in {parent.Id}: move the outer type.");
        SameLanguage(s, type, to);
        var from = type.Parent;
        type.Parent = to.Id;
        type.Namespace = to.Namespace ?? to.Name;
        s.Reproject(type, to.Project ?? to.Parent);
        type.AddTag(MovedTag);
        return $"moved {type.Name} from {from} to {to.Id}";
    }

    private static string MoveMember(State s, MoveMemberOp o)
    {
        var member = s.Node(o.Member, "member");
        var to = s.Node(o.To, "type");
        if (!NodeLevels.IsMember(member)) throw new SimulationException($"{member.Id} is not a member.");
        if (!NodeLevels.IsType(to) && !ClassMetrics.IsClass(to)) throw new SimulationException($"{to.Id} is not a type or class.");
        SameLanguage(s, member, to);
        var from = member.Parent;
        member.Parent = to.Id;
        s.Reproject(member, to.Project);
        member.AddTag(MovedTag);
        return $"moved {member.Name} from {from} to {to.Id}";
    }

    private static string MoveNamespace(State s, MoveNamespaceOp o)
    {
        var ns = s.Node(o.Namespace, "namespace");
        var project = s.Node(o.ToProject, "project");
        if (ns.Kind != NodeKinds.Namespace) throw new SimulationException($"{ns.Id} is not a namespace.");
        if (project.Kind != NodeKinds.Project) throw new SimulationException($"{project.Id} is not a project.");
        SameLanguage(s, ns, project);
        ns.Parent = project.Id;
        s.Reproject(ns, project.Id);
        ns.AddTag(MovedTag);
        return $"moved namespace {ns.Name} to project {project.Name}";
    }

    private static string MergeNamespaces(State s, MergeNamespacesOp o)
    {
        var from = s.Node(o.From, "namespace to merge");
        var into = s.Node(o.Into, "namespace to merge into");
        if (from.Kind != NodeKinds.Namespace || into.Kind != NodeKinds.Namespace) throw new SimulationException("both must be namespaces.");
        if (from.Id == into.Id) throw new SimulationException("a namespace cannot merge into itself.");
        SameLanguage(s, from, into);
        var children = s.Children(from.Id).ToList();
        foreach (var child in children)
        {
            child.Parent = into.Id;
            if (NodeLevels.IsType(child)) child.Namespace = into.Namespace ?? into.Name;
            s.Reproject(child, into.Project ?? into.Parent);
            child.AddTag(MovedTag);
        }

        s.Remove(new[] { from.Id });
        return $"merged {from.Name} ({children.Count} nodes) into {into.Name}";
    }

    private static string RemoveDependency(State s, RemoveDependencyOp o)
    {
        var from = s.Node(o.From, "from");
        var to = s.Node(o.To, "to");
        var sources = s.Within(from.Id);
        var targets = s.Within(to.Id);
        var kinds = o.Kinds is { Count: > 0 } ? o.Kinds.ToHashSet(StringComparer.Ordinal) : null;
        var removed = s.Graph.Edges.RemoveAll(e => sources.Contains(e.Source) && targets.Contains(e.Target) && (kinds == null || kinds.Contains(e.Kind)));
        if (removed == 0) throw new SimulationException($"{from.Id} has no {(kinds != null ? string.Join("/", kinds) + " " : "")}references to {to.Id}.");
        if (s.Graph.Analysis.Di is { } di)
        {
            di.Dependencies.RemoveAll(d => sources.Contains(d.Consumer) && targets.Contains(d.Service));
        }

        return $"removed {removed} reference(s) from {from.Name} to {to.Name}";
    }

    private static string InvertDependency(State s, InvertDependencyOp o)
    {
        var from = s.Node(o.From, "from");
        var to = s.Node(o.To, "to");
        var sources = s.Within(from.Id);
        var targets = s.Within(to.Id);
        var edges = s.Graph.Edges.Where(e => sources.Contains(e.Source) && targets.Contains(e.Target) && e.Kind != EdgeKinds.ChangesWith).ToList();
        if (edges.Count == 0) throw new SimulationException($"{from.Id} does not depend on {to.Id}.");

        string? TypeOf(string id)
        {
            for (var node = s.ById.GetValueOrDefault(id); node != null; node = node.Parent != null ? s.ById.GetValueOrDefault(node.Parent) : null)
            {
                if (NodeLevels.IsType(node) || ClassMetrics.IsClass(node) || node.Kind == NodeKinds.Interface) return node.Id;
                if (!NodeLevels.IsMember(node)) return null;
            }

            return null;
        }

        var home = o.InterfaceIn != null ? s.Node(o.InterfaceIn, "interfaceIn") : null;
        if (home != null && home.Kind != NodeKinds.Namespace && !NodeLevels.IsType(home)) throw new SimulationException($"{home.Id} is not a namespace or a file.");

        var interfaces = 0;
        var repointed = 0;
        var notInverted = 0;
        foreach (var group in edges.GroupBy(e => TypeOf(e.Target)).Where(g => g.Key != null))
        {
            var target = s.ById[group.Key!];
            var inheritance = group.Where(e => e.Kind is EdgeKinds.Inherits or EdgeKinds.Extends).ToList();
            notInverted += inheritance.Count;
            var movable = group.Except(inheritance).ToList();
            if (movable.Count == 0) continue;

            // The interface sits where its first user is, or where it was asked to go.
            var firstUser = s.ById.GetValueOrDefault(movable[0].Source);
            var place = home ?? (firstUser != null && s.NamespaceOf(firstUser) is { } ns ? s.ById[ns] : null)
                        ?? throw new SimulationException($"no namespace for the interface of {target.Name}: give interfaceIn.");
            var iface = Interface(s, target, $"I{target.Name.TrimStart('I')}", place, members: null);
            interfaces++;

            foreach (var edge in movable)
            {
                var replacement = edge.Target == target.Id ? iface.Type.Id : iface.Members.GetValueOrDefault(edge.Target);
                if (replacement == null)
                {
                    // A member the interface does not have yet (a field, a static): add it.
                    if (s.ById.GetValueOrDefault(edge.Target) is { } member && NodeLevels.IsMember(member)) replacement = InterfaceMember(s, iface, member).Id;
                    else continue;
                }

                edge.Target = replacement;
                repointed++;
            }

            // The container injects the implementation for the interface.
            if (s.Graph.Analysis.Di is { } di)
            {
                foreach (var dependency in di.Dependencies.Where(d => sources.Contains(d.Consumer) && d.Service == target.Id)) dependency.Service = iface.Type.Id;
                foreach (var registration in di.Registrations.Where(r => r.Service == target.Id || r.Implementation == target.Id).ToList())
                {
                    di.Registrations.Add(new ServiceRegistration { Service = iface.Type.Id, Implementation = target.Id, Lifetime = registration.Lifetime, Kind = "type", Framework = registration.Framework, RegisteredIn = registration.RegisteredIn, Location = registration.Location });
                }
            }
        }

        if (notInverted > 0) s.Notes.Add($"{notInverted} inheritance reference(s) from {from.Name} to {to.Name} cannot be inverted with an interface and were left as they are.");
        if (interfaces == 0) throw new SimulationException($"only inheritance joins {from.Id} to {to.Id}: nothing to invert.");
        return $"inverted {repointed} reference(s) from {from.Name} to {to.Name} through {interfaces} interface(s)";
    }

    private static string ExtractInterface(State s, ExtractInterfaceOp o)
    {
        var type = s.Node(o.Type, "type");
        if (!NodeLevels.IsType(type) && !ClassMetrics.IsClass(type)) throw new SimulationException($"{type.Id} is not a type.");
        var owned = s.Within(type.Id);
        var members = s.Children(type.Id).Where(NodeLevels.IsMember).ToList();
        List<GraphNode> chosen;
        if (o.Members is { Count: > 0 } names)
        {
            chosen = new List<GraphNode>();
            foreach (var name in names)
            {
                chosen.Add(members.FirstOrDefault(m => m.Id == name || m.Name == name) ?? throw new SimulationException($"{type.Name} has no member '{name}'."));
            }
        }
        else
        {
            var usedFromOutside = s.Graph.Edges.Where(e => owned.Contains(e.Target) && !owned.Contains(e.Source)).Select(e => e.Target).ToHashSet(StringComparer.Ordinal);
            chosen = members.Where(m => usedFromOutside.Contains(m.Id) && m.Kind is not NodeKinds.Constructor && m.Modifiers?.Contains("static") != true).ToList();
        }

        var place = o.In != null ? s.Node(o.In, "in") : s.NamespaceOf(type) is { } ns ? s.ById[ns] : throw new SimulationException($"{type.Id} is in no namespace: give in.");
        var iface = Interface(s, type, o.Name ?? $"I{type.Name}", place, chosen);

        // Everyone outside the type now uses the interface for what it has.
        var repointed = 0;
        foreach (var edge in s.Graph.Edges.Where(e => !owned.Contains(e.Source) && e.Kind is not (EdgeKinds.Inherits or EdgeKinds.Implements or EdgeKinds.Extends)))
        {
            if (edge.Target == type.Id) { edge.Target = iface.Type.Id; repointed++; }
            else if (iface.Members.TryGetValue(edge.Target, out var m) && edge.Source != iface.Type.Id) { edge.Target = m; repointed++; }
        }

        return $"extracted {iface.Type.Name} with {chosen.Count} member(s) from {type.Name}; {repointed} reference(s) now use it";
    }

    private sealed record Created(GraphNode Type, Dictionary<string, string> Members);

    /// <summary>A new interface for a type: in a namespace (or a file), implemented by the type, with copies of members.</summary>
    private static Created Interface(State s, GraphNode type, string name, GraphNode place, IReadOnlyList<GraphNode>? members)
    {
        var csharp = s.Language(type) == "csharp" && place.Kind == NodeKinds.Namespace;
        var nsName = place.Namespace ?? place.Name;
        var predicted = csharp ? $"T:{(nsName is "(global)" or "" ? "" : nsName + ".")}{name}" : null;
        var existing = s.Graph.Nodes.FirstOrDefault(n => n.Tags?.Contains(SimulatedTag) == true && n.Kind == NodeKinds.Interface && n.Name == name && n.Parent == place.Id);
        GraphNode iface;
        if (existing != null)
        {
            iface = existing;
        }
        else
        {
            iface = s.Add(new GraphNode
            {
                Id = predicted ?? $"sim:{place.Id}/{name}",
                Kind = NodeKinds.Interface,
                Level = csharp ? null : NodeLevels.Type,
                Name = name,
                FullName = csharp ? predicted![2..] : $"{place.FullName ?? place.Name}/{name}",
                Parent = place.Id,
                Project = place.Project ?? place.Parent,
                Namespace = place.Kind == NodeKinds.Namespace ? nsName : place.Namespace,
                Accessibility = "public",
                Location = type.Location == null ? null : new SourceLocation { File = type.Location.File, Line = type.Location.Line, EndLine = type.Location.Line },
            });
            if (predicted != null && iface.Id != predicted) s.Predicted[iface.Id] = predicted;
            else if (predicted != null) s.Predicted[iface.Id] = iface.Id;
            s.Graph.Edges.Add(new GraphEdge { Source = type.Id, Target = iface.Id, Kind = EdgeKinds.Implements });
        }

        var created = new Created(iface, new Dictionary<string, string>(StringComparer.Ordinal));
        foreach (var other in s.Children(iface.Id).Where(NodeLevels.IsMember))
        {
            var original = s.Graph.Edges.FirstOrDefault(e => e.Kind == EdgeKinds.Implements && e.Target == other.Id)?.Source;
            if (original != null) created.Members[original] = other.Id;
        }

        foreach (var member in members ?? Array.Empty<GraphNode>()) InterfaceMember(s, created, member);
        return created;
    }

    private static GraphNode InterfaceMember(State s, Created iface, GraphNode member)
    {
        if (iface.Members.TryGetValue(member.Id, out var known)) return s.ById[known];
        var csharp = iface.Type.Id.StartsWith("T:", StringComparison.Ordinal) && member.Id.Length > 2 && member.Id[1] == ':';
        string? predicted = null;
        if (csharp && member.Parent is { } owner && owner.StartsWith("T:", StringComparison.Ordinal) && member.Id[2..].StartsWith(owner[2..] + ".", StringComparison.Ordinal))
        {
            predicted = $"{member.Id[..2]}{iface.Type.Id[2..]}{member.Id[(owner.Length)..]}";
        }

        var copy = s.Add(new GraphNode
        {
            Id = predicted ?? $"{iface.Type.Id}.{member.Name}",
            Kind = member.Kind,
            Level = member.Level,
            Name = member.Name,
            FullName = $"{iface.Type.FullName}.{member.Name}",
            Parent = iface.Type.Id,
            Project = iface.Type.Project,
            Accessibility = "public",
            Signature = member.Signature,
            Modifiers = new List<string> { "abstract" },
            Location = iface.Type.Location,
        });
        if (predicted != null) s.Predicted[copy.Id] = predicted;
        s.Graph.Edges.Add(new GraphEdge { Source = member.Id, Target = copy.Id, Kind = EdgeKinds.Implements });
        iface.Members[member.Id] = copy.Id;
        return copy;
    }

    private static string SplitType(State s, SplitTypeOp o)
    {
        var type = s.Node(o.Type, "type");
        if (!NodeLevels.IsType(type) && !ClassMetrics.IsClass(type)) throw new SimulationException($"{type.Id} is not a type.");
        if (o.Parts.Count == 0) throw new SimulationException("splitType needs parts.");
        var members = s.Children(type.Id).Where(NodeLevels.IsMember).ToList();
        var taken = new HashSet<string>(StringComparer.Ordinal);
        var lines = new List<string>();
        foreach (var part in o.Parts)
        {
            if (string.IsNullOrWhiteSpace(part.Name)) throw new SimulationException("every part needs a name.");
            var moving = new List<GraphNode>();
            foreach (var name in part.Members)
            {
                var member = members.FirstOrDefault(m => m.Id == name) ?? members.SingleOrDefault(m => m.Name == name)
                             ?? throw new SimulationException($"{type.Name} has no member '{name}' (or more than one: use its id).");
                if (!taken.Add(member.Id)) throw new SimulationException($"{member.Name} is in two parts.");
                moving.Add(member);
            }

            if (moving.Count == 0) throw new SimulationException($"part {part.Name} has no members.");
            var csharp = s.Language(type) == "csharp" && type.Id.StartsWith("T:", StringComparison.Ordinal);
            var ns = type.Namespace;
            var predicted = csharp ? $"T:{(string.IsNullOrEmpty(ns) || ns == "(global)" ? "" : ns + ".")}{part.Name}" : null;
            var created = s.Add(new GraphNode
            {
                Id = predicted ?? $"sim:{type.Id}/{part.Name}",
                Kind = ClassMetrics.IsClass(type) ? type.Kind : NodeKinds.Class,
                Level = type.Level,
                Name = part.Name,
                FullName = predicted?[2..] ?? $"{type.FullName ?? type.Name}/{part.Name}",
                Parent = type.Parent,
                Project = type.Project,
                Namespace = type.Namespace,
                Accessibility = type.Accessibility ?? "public",
                Location = type.Location == null ? null : new SourceLocation { File = type.Location.File, Line = type.Location.Line, EndLine = type.Location.Line },
            });
            if (predicted != null) s.Predicted[created.Id] = predicted;
            foreach (var member in moving)
            {
                member.Parent = created.Id;
                member.AddTag(MovedTag);
            }

            lines.Add($"{part.Name} ({moving.Count})");
        }

        return $"split {type.Name}: {string.Join(", ", lines)}; {members.Count - taken.Count} member(s) stay";
    }

    private static string RemoveNode(State s, RemoveNodeOp o)
    {
        var node = s.Node(o.Node, "node");
        if (node.Kind == NodeKinds.Project) throw new SimulationException("whole projects are not removed; remove its namespaces or types.");
        var ids = s.Within(node.Id);
        var references = s.Graph.Edges.Count(e => ids.Contains(e.Target) && !ids.Contains(e.Source));
        s.Remove(ids);
        if (references > 0) s.Notes.Add($"{node.Name} was still referenced {references} time(s); those references were removed with it.");
        return $"removed {node.Name} ({ids.Count} node(s))";
    }

    private static string SetLifetime(State s, SetLifetimeOp o)
    {
        if (!Lifetimes.Contains(o.Lifetime)) throw new SimulationException($"lifetime must be {string.Join(", ", Lifetimes)}.");
        var di = s.Graph.Analysis.Di ?? throw new SimulationException("the map has no DI registrations.");
        var registrations = di.Registrations.Where(r => r.Service == o.Service || r.Implementation == o.Service).ToList();
        if (registrations.Count == 0) throw new SimulationException($"nothing registers {o.Service}.");
        foreach (var registration in registrations) registration.Lifetime = o.Lifetime;
        return $"{registrations.Count} registration(s) of {o.Service} are now {o.Lifetime}";
    }
}
