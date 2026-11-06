using System.Text;
using System.Text.RegularExpressions;
using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>
/// Call flow: what happens when an entry point runs. Follows <c>calls</c> edges in source order (edges carry the line
/// of the first call), through interface and abstract members to their implementations; when the DI analysis knows
/// which implementation the caller receives, only that one is followed. The same rules as the viewer's Flow view
/// (viewer/src/data/flow.js), so a flow an agent reads is the flow a person sees.
/// </summary>
public sealed class CallFlow
{
    /// <summary>One step of a flow tree: a call (or a <c>create</c>) of a member, with what it calls in turn.</summary>
    public sealed class Step
    {
        public required string Id { get; init; }
        public required GraphNode Node { get; init; }

        /// <summary>call | create</summary>
        public string Kind { get; init; } = "call";

        public int Line { get; init; }
        public List<Step> Children { get; } = new();

        /// <summary>A call through an interface or abstract member: the implementations it reaches.</summary>
        public Dispatch? Dispatch { get; set; }

        /// <summary>Already expanded earlier in the flow (and it calls something).</summary>
        public bool Repeat { get; set; }

        public bool Recursive { get; set; }

        /// <summary>Not expanded: the flow is deeper or bigger than its limits.</summary>
        public bool Truncated { get; set; }
    }

    public sealed class Dispatch
    {
        public required List<string> Ids { get; init; }

        /// <summary>The DI wiring of the caller picked these implementations.</summary>
        public bool Narrowed { get; init; }

        /// <summary>IEnumerable&lt;T&gt;: the caller gets every implementation.</summary>
        public bool Many { get; init; }

        /// <summary>Implementations there are in all.</summary>
        public int Total { get; init; }

        public List<Step> Targets { get; } = new();
    }

    public sealed record Flow(List<GraphNode> Roots, List<Step> Tree, List<GraphNode> Methods, int Types, int Depth, bool Truncated, int MaxDepth);

    /// <summary>A likely starting point: a controller, hub, background service, handler, middleware or Main.</summary>
    public sealed record EntryPoint(GraphNode Node, string Role, string Title, List<GraphNode> Methods, int Reach);

    private sealed record RoleEntry(string Role, string Title, Func<GraphNode, bool> Methods);

    private static readonly Regex HostedMethods = new("^(ExecuteAsync|StartAsync|StopAsync)$");
    private static readonly Regex HandlerMethods = new("^(Handle|HandleAsync|Consume|ConsumeAsync|Execute|ExecuteAsync)$");
    private static readonly Regex MiddlewareMethods = new("^(Invoke|InvokeAsync)$");

    private static readonly RoleEntry[] RoleEntries =
    {
        new(Tags.Controller, "Controllers", IsPublicInstance),
        new(Tags.Hub, "SignalR hubs", IsPublicInstance),
        new(Tags.HostedService, "Background services", m => HostedMethods.IsMatch(m.Name)),
        new(Tags.Handler, "Handlers", m => HandlerMethods.IsMatch(m.Name)),
        new(Tags.Middleware, "Middleware", m => MiddlewareMethods.IsMatch(m.Name)),
        new(Tags.EntryPoint, "Program entry", m => m.HasTag(Tags.EntryPoint)),
    };

    /// <summary>The kinds of the viewer's owners (a member's class, TypeScript classes included).</summary>
    private static readonly HashSet<string> TypeKinds = new(StringComparer.Ordinal)
    {
        NodeKinds.Class, NodeKinds.Interface, NodeKinds.Struct, NodeKinds.Record, NodeKinds.RecordStruct, NodeKinds.Enum, NodeKinds.Delegate,
    };

    /// <summary>Members a flow can run through (and dispatch to through implements / overrides).</summary>
    private static readonly HashSet<string> Callable = new(StringComparer.Ordinal) { NodeKinds.Method, NodeKinds.Constructor, NodeKinds.Function };

    /// <summary>Members that can start a flow.</summary>
    private static readonly HashSet<string> EntryKinds = new(StringComparer.Ordinal) { NodeKinds.Method, NodeKinds.Function };

    private readonly GraphIndex _index;
    private readonly Dictionary<string, List<GraphEdge>> _calls = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _implementors = new(StringComparer.Ordinal);
    private readonly Dictionary<(string Consumer, string Service), (List<string> Implementations, bool Many)> _injected = new();
    private readonly HashSet<string> _testProjects;

    public CallFlow(GraphIndex index)
    {
        _index = index;
        foreach (var edge in index.Graph.Edges)
        {
            if (edge.Kind is EdgeKinds.Calls or EdgeKinds.Instantiates)
            {
                if (!_calls.TryGetValue(edge.Source, out var list)) _calls[edge.Source] = list = new List<GraphEdge>();
                list.Add(edge);
            }
            else if (edge.Kind is EdgeKinds.Implements or EdgeKinds.Overrides && index.Node(edge.Source) is { } source && Callable.Contains(source.Kind))
            {
                if (!_implementors.TryGetValue(edge.Target, out var list)) _implementors[edge.Target] = list = new List<string>();
                list.Add(edge.Source);
            }
        }

        foreach (var key in _calls.Keys.ToList())
        {
            _calls[key] = _calls[key]
                .OrderBy(e => e.Line == 0 ? 1e9 : e.Line)
                .ThenBy(e => e.Kind == EdgeKinds.Instantiates ? 0 : 1)
                .ThenBy(e => e.Target, StringComparer.Ordinal)
                .ToList();
        }

        foreach (var d in index.Graph.Analysis.Di?.Dependencies ?? new List<DiDependency>())
        {
            if (d.Implementations.Count > 0) _injected[(d.Consumer, d.Service)] = (d.Implementations, d.Many);
        }

        _testProjects = index.Graph.Nodes.Where(n => n.HasTag(Tags.TestProject)).Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>Whether a member calls or creates anything.</summary>
    public bool HasCalls(string id) => _calls.ContainsKey(id);

    /// <summary>The flows from members (a type stands for its entry methods).</summary>
    public Flow Build(IEnumerable<string> rootIds, int maxDepth = 8, int maxNodes = 600, bool showTests = true)
    {
        var roots = ExpandRoots(rootIds);
        bool Visible(GraphNode? n) => n != null && !n.External && (showTests || !IsTest(n));
        var expanded = new HashSet<string>(StringComparer.Ordinal);
        var count = 0;
        var truncated = false;

        Dispatch? ImplementationsOf(GraphNode target, GraphNode caller)
        {
            var all = (_implementors.GetValueOrDefault(target.Id) ?? new List<string>()).Where(id => Visible(_index.Node(id))).ToList();
            if (all.Count == 0 || !IsAbstractMember(target)) return null;
            if (OwnerOf(caller) is { } callerOwner && OwnerOf(target) is { } targetOwner && _injected.TryGetValue((callerOwner.Id, targetOwner.Id), out var wired))
            {
                var allowed = wired.Implementations.ToHashSet(StringComparer.Ordinal);
                var narrowed = all.Where(id => OwnerOf(_index.Node(id)) is { } owner && allowed.Contains(owner.Id)).ToList();
                // IEnumerable<T>: the caller gets every implementation and typically calls each one.
                if (narrowed.Count > 0) return new Dispatch { Ids = narrowed, Narrowed = true, Many = wired.Many, Total = all.Count };
            }

            return new Dispatch { Ids = all.Take(6).ToList(), Total = all.Count };
        }

        Step Expand(string id, int depth, HashSet<string> path, int line = 0)
        {
            var node = _index.Node(id)!;
            var step = new Step { Id = id, Node = node, Line = line };
            count++;
            var outgoing = _calls.GetValueOrDefault(id) ?? new List<GraphEdge>();
            if (path.Contains(id))
            {
                step.Recursive = true;
                return step;
            }

            if (expanded.Contains(id))
            {
                step.Repeat = outgoing.Count > 0;
                return step;
            }

            if (outgoing.Count == 0) return step;
            if (depth >= maxDepth || count >= maxNodes)
            {
                truncated = true;
                step.Truncated = true;
                return step;
            }

            expanded.Add(id);
            path.Add(id);
            foreach (var call in outgoing)
            {
                var target = _index.Node(call.Target);
                if (!Visible(target)) continue;
                if (call.Kind == EdgeKinds.Instantiates)
                {
                    step.Children.Add(new Step { Id = target!.Id, Node = target, Kind = "create", Line = call.Line });
                    continue;
                }

                var dispatch = ImplementationsOf(target!, node);
                if (dispatch != null)
                {
                    count++;
                    var child = new Step { Id = target!.Id, Node = target, Line = call.Line, Dispatch = dispatch };
                    step.Children.Add(child);
                    foreach (var implementation in dispatch.Ids) dispatch.Targets.Add(Expand(implementation, depth + 1, path, call.Line));
                }
                else
                {
                    step.Children.Add(Expand(target!.Id, depth + 1, path, call.Line));
                }
            }

            path.Remove(id);
            return step;
        }

        var tree = roots.Select(root => Expand(root.Id, 0, new HashSet<string>(StringComparer.Ordinal))).ToList();

        // Unique methods of the flow with the shortest depth of each (dispatch is not a call level).
        var methods = new List<GraphNode>();
        var depthOf = new Dictionary<string, int>(StringComparer.Ordinal);
        void Visit(Step step, int depth)
        {
            if (step.Kind == "create") return;
            if (!depthOf.ContainsKey(step.Id)) methods.Add(step.Node);
            if (!depthOf.TryGetValue(step.Id, out var known) || depth < known) depthOf[step.Id] = depth;
            foreach (var child in step.Children.Where(c => c.Kind != "create")) Visit(child, depth + 1);
            foreach (var target in step.Dispatch?.Targets ?? new List<Step>()) Visit(target, depth);
        }

        foreach (var root in tree) Visit(root, 0);
        var types = methods.Select(m => TypeNodeOf(m)?.Id).Where(id => id != null).Distinct(StringComparer.Ordinal).Count();
        return new Flow(roots, tree, methods, types, depthOf.Count == 0 ? 0 : Math.Max(0, depthOf.Values.Max()), truncated, maxDepth);
    }

    private List<GraphNode> ExpandRoots(IEnumerable<string> rootIds)
    {
        var result = new List<GraphNode>();
        foreach (var id in rootIds)
        {
            if (_index.Node(id) is not { } node) continue;
            // A member that holds members (a TypeScript class) starts its flows like a type.
            if (NodeLevels.IsMember(node) && !_index.Children(node.Id).Any(NodeLevels.IsMember)) result.Add(node);
            else result.AddRange(EntryMethodsOf(node));
        }

        return result;
    }

    /// <summary>
    /// The methods of a type that start a flow: members marked as routes or entry points (Express and Nest handlers),
    /// else by role: actions of a controller, ExecuteAsync of a hosted service…
    /// </summary>
    public List<GraphNode> EntryMethodsOf(GraphNode type)
    {
        var members = new List<GraphNode>();
        var pending = new Queue<GraphNode>(_index.Children(type.Id));
        while (pending.Count > 0)
        {
            var member = pending.Dequeue();
            if (!NodeLevels.IsMember(member)) continue;
            if (EntryKinds.Contains(member.Kind)) members.Add(member);
            foreach (var child in _index.Children(member.Id)) pending.Enqueue(child);
        }

        var marked = members.Where(m => m.HasTag("route") || m.HasTag(Tags.EntryPoint)).ToList();
        if (marked.Count > 0) return marked;
        foreach (var entry in RoleEntries)
        {
            if (!type.HasTag(entry.Role)) continue;
            var methods = members.Where(entry.Methods).ToList();
            if (methods.Count > 0) return methods;
        }

        var publicMethods = members.Where(m => m.Accessibility == "public" && _calls.ContainsKey(m.Id)).ToList();
        return publicMethods.Count > 0 ? publicMethods : members.Where(m => _calls.ContainsKey(m.Id)).ToList();
    }

    /// <summary>Likely entry points, best first: controllers, hubs, background services, handlers, middleware, Main.</summary>
    public List<EntryPoint> FindEntryPoints(int limit = 40)
    {
        var found = new List<(GraphNode Node, RoleEntry Entry, List<GraphNode> Methods)>();
        foreach (var type in _index.Graph.Nodes)
        {
            // Types, and classes that are members of a file (TypeScript).
            if (!(NodeLevels.IsType(type) || NodeLevels.IsMember(type) && TypeKinds.Contains(type.Kind)) || type.External || IsTest(type)) continue;
            var entry = RoleEntries.FirstOrDefault(e => type.HasTag(e.Role));
            if (entry == null) continue;
            var methods = EntryMethodsOf(type).Where(m => _calls.ContainsKey(m.Id)).ToList();
            if (methods.Count == 0) continue;
            found.Add((type, entry, methods));
        }

        // A file whose entry methods are all a class' (a NestJS controller and its file): the class is enough.
        var ofClasses = found.Where(r => NodeLevels.IsMember(r.Node)).SelectMany(r => r.Methods.Select(m => m.Id)).ToHashSet(StringComparer.Ordinal);
        found.RemoveAll(r => NodeLevels.IsType(r.Node) && r.Methods.All(m => ofClasses.Contains(m.Id)));

        var order = RoleEntries.Select((e, i) => (e.Role, i)).ToDictionary(p => p.Role, p => p.i, StringComparer.Ordinal);
        return found
            .Select(r => new EntryPoint(r.Node, r.Entry.Role, r.Entry.Title, r.Methods, Build(new[] { r.Node.Id }, maxDepth: 12, maxNodes: 400).Methods.Count))
            .OrderBy(e => order[e.Role])
            .ThenByDescending(e => e.Reach)
            .ThenBy(e => e.Node.Name, StringComparer.Ordinal)
            .Take(limit)
            .ToList();
    }

    // ------------------------------------------------------------------ sequence diagram

    /// <summary>How a call to a member reads on a sequence diagram: <c>place()</c>, or a route as it is (<c>GET /orders/:id</c>).</summary>
    public static string CallLabel(GraphNode node) => node.HasTag("route") ? node.Name : $"{node.Name}()";

    private sealed record SeqStep(string Type, int From = 0, int To = 0, int At = 0, string Label = "", string? Via = null, string? Note = null);

    /// <summary>
    /// Mermaid <c>sequenceDiagram</c> text for one flow tree. Participants are types; a call through an interface goes
    /// straight to the implementation (labelled with the interface), several possible implementations become an
    /// <c>alt</c> block, IEnumerable injection a <c>loop</c>. Object creation is shown only for types that also take part.
    /// </summary>
    public string ToMermaid(Step root)
    {
        var participants = new List<GraphNode>();
        var indexOf = new Dictionary<string, int>(StringComparer.Ordinal);
        int Participant(GraphNode node)
        {
            var type = OwnerOf(node) ?? node;
            if (!indexOf.TryGetValue(type.Id, out var i))
            {
                indexOf[type.Id] = i = participants.Count;
                participants.Add(type);
            }

            return i;
        }

        var called = new HashSet<string>(StringComparer.Ordinal);
        void Collect(Step t)
        {
            if (t.Kind == "create") return;
            called.Add((OwnerOf(t.Node) ?? t.Node).Id);
            foreach (var child in t.Children) Collect(child);
            foreach (var target in t.Dispatch?.Targets ?? new List<Step>()) Collect(target);
        }

        Collect(root);
        var steps = new List<SeqStep>();

        void Message(Step t, int from, string label, string? via = null)
        {
            var to = Participant(t.Node);
            var note = t.Recursive ? "recursion" : t.Repeat ? "see above" : t.Truncated ? "…" : null;
            steps.Add(new SeqStep("call", From: from, To: to, Label: label, Via: via, Note: note));
            if (t.Children.Count == 0) return;
            var mark = steps.Count;
            steps.Add(new SeqStep("activate", At: to));
            Walk(t, to);
            // Only hidden creations inside: no activation bar.
            if (steps.Count == mark + 1) steps.RemoveAt(steps.Count - 1);
            else steps.Add(new SeqStep("deactivate", At: to));
        }

        void Walk(Step t, int from)
        {
            foreach (var child in t.Children)
            {
                if (child.Kind == "create")
                {
                    if (called.Contains(child.Node.Id)) steps.Add(new SeqStep("create", From: from, To: Participant(child.Node), Label: $"new {child.Node.Name}"));
                    continue;
                }

                if (child.Dispatch is { } dispatch)
                {
                    var targets = dispatch.Targets;
                    var via = OwnerOf(child.Node)?.Name ?? "";
                    if (targets.Count == 1)
                    {
                        Message(targets[0], from, CallLabel(child.Node), via);
                    }
                    else if (dispatch.Many)
                    {
                        steps.Add(new SeqStep("loop", Label: $"each {via}"));
                        foreach (var target in targets) Message(target, from, CallLabel(child.Node), via);
                        steps.Add(new SeqStep("end"));
                    }
                    else
                    {
                        for (var i = 0; i < targets.Count; i++)
                        {
                            steps.Add(new SeqStep(i == 0 ? "alt" : "else", Label: OwnerOf(targets[i].Node)?.Name ?? targets[i].Node.Name));
                            Message(targets[i], from, CallLabel(child.Node), via);
                        }

                        steps.Add(new SeqStep("end"));
                    }

                    continue;
                }

                Message(child, from, CallLabel(child.Node));
            }
        }

        var start = Participant(root.Node);
        steps.Add(new SeqStep("start", At: start, Label: CallLabel(root.Node)));
        Walk(root, start);

        static string Esc(string text) => Regex.Replace(text, "[<>;#\"]", m => $"#{(int)m.Value[0]};");
        var lines = new List<string> { "sequenceDiagram", "    autonumber" };
        for (var i = 0; i < participants.Count; i++) lines.Add($"    participant P{i} as {Esc(participants[i].Name)}");
        var indent = "    ";
        foreach (var s in steps)
        {
            switch (s.Type)
            {
                case "start": lines.Add($"{indent}Note over P{s.At}: {Esc(s.Label)}"); break;
                case "call": lines.Add($"{indent}P{s.From}->>P{s.To}: {Esc(s.Label + (string.IsNullOrEmpty(s.Via) ? "" : $" [{s.Via}]") + (s.Note != null ? $" ({s.Note})" : ""))}"); break;
                case "create": lines.Add($"{indent}P{s.From}-)P{s.To}: {Esc(s.Label)}"); break;
                case "activate": lines.Add($"{indent}activate P{s.At}"); break;
                case "deactivate": lines.Add($"{indent}deactivate P{s.At}"); break;
                case "alt" or "loop":
                    lines.Add($"{indent}{s.Type} {Esc(s.Label)}");
                    indent += "    ";
                    break;
                case "else": lines.Add($"{indent[4..]}else {Esc(s.Label)}"); break;
                case "end":
                    indent = indent[4..];
                    lines.Add($"{indent}end");
                    break;
            }
        }

        var sb = new StringBuilder();
        foreach (var line in lines) sb.Append(line).Append('\n');
        return sb.ToString();
    }

    // ------------------------------------------------------------------ the viewer's notions of owner and test

    /// <summary>Who a member belongs to on a sequence diagram: its class (C# type, TypeScript class), else its file.</summary>
    public GraphNode? OwnerOf(GraphNode? node)
    {
        if (node == null) return null;
        return _index.AncestorsAndSelf(node).FirstOrDefault(n => TypeKinds.Contains(n.Kind)) ?? TypeNodeOf(node);
    }

    private GraphNode? TypeNodeOf(GraphNode node) => _index.AncestorsAndSelf(node).FirstOrDefault(NodeLevels.IsType);

    private bool IsAbstractMember(GraphNode node) => OwnerOf(node)?.Kind == NodeKinds.Interface || node.Modifiers?.Contains("abstract") == true;

    /// <summary>As the viewer: in a test project, or tagged as a test itself.</summary>
    private bool IsTest(GraphNode node)
    {
        var project = _index.AncestorsAndSelf(node).FirstOrDefault(n => n.Kind == NodeKinds.Project)
                      ?? (node.Project != null ? _index.Node(node.Project) : null)
                      ?? _index.AncestorsAndSelf(node).Last();
        return _testProjects.Contains(project.Id) || node.HasTag(Tags.Test);
    }

    private static bool IsPublicInstance(GraphNode m) => m.Kind == NodeKinds.Method && m.Accessibility == "public" && m.Modifiers?.Contains("static") != true;
}
