using System.Diagnostics;
using System.Text.RegularExpressions;
using CodeMap.Analysis;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Insights;

/// <summary>A refactoring CodeMap suggests: what to do, as simulator operations and as code-edit steps, what it costs and what it fixes.</summary>
public sealed class Proposal
{
    /// <summary><c>kind@key</c>, stable for the same suggestion.</summary>
    public required string Id { get; init; }

    /// <summary>break-cycle, invert-dependency, move-type, move-member, split-type, merge-namespaces, remove-dead-code, fix-di</summary>
    public required string Kind { get; init; }

    public required string Title { get; init; }
    public required string Rationale { get; init; }

    /// <summary>0 to 1: how sure CodeMap is that it is a good idea (verified proposals that fix their finding rank highest).</summary>
    public double Confidence { get; set; }

    /// <summary>The change as simulator operations (pass them to simulate).</summary>
    public required List<SimOp> Ops { get; init; }

    public required ProposalCost Cost { get; init; }

    /// <summary>Concrete steps in the code, with file:line.</summary>
    public required List<string> Steps { get; init; }

    /// <summary>The findings it is meant to remove.</summary>
    public required List<string> Targets { get; init; }

    /// <summary>What a full simulation of it shows; null when it was not verified.</summary>
    public ProposalPrediction? Predicted { get; set; }
}

/// <param name="References">References in the code that change.</param>
/// <param name="Files">Files to edit.</param>
/// <param name="Members">Members that move or get a new home.</param>
public sealed record ProposalCost(int References, int Files, int Members);

public sealed record ProposalPrediction(int ScoreBefore, int ScoreAfter, List<string> Resolved, List<string> Added, List<string> Summary);

public sealed class ProposalRequest
{
    /// <summary>Only for this finding (its id).</summary>
    public string? Finding { get; init; }

    /// <summary>Only for findings about nodes inside this node.</summary>
    public string? Scope { get; init; }

    /// <summary>Only these kinds.</summary>
    public IReadOnlyCollection<string>? Kinds { get; init; }

    public int Limit { get; init; } = 5;

    /// <summary>Simulate the best candidates for real (slower, but says what they actually fix).</summary>
    public bool Verify { get; init; } = true;

    /// <summary>Time for the whole search; when it is up, the rest is returned unverified.</summary>
    public TimeSpan Budget { get; init; } = TimeSpan.FromSeconds(20);
}

/// <summary>
/// Suggests refactorings for the findings of a map: candidates from each finding (cut a cycle by inverting or moving,
/// invert layer violations, move envious methods, split god classes along their clusters of members, merge tiny
/// namespaces, delete dead code, fix DI lifetimes), scored fast on a compact model, the best simulated for real.
/// A candidate that adds a cycle or an error is dropped.
/// </summary>
public static class ProposalEngine
{
    private const int CandidatesPerFinding = 6;

    public static List<Proposal> Propose(RawGraph raw, CodeGraph derived, FindingsReport findings, GraphIndex index, ProposalRequest? request = null, CancellationToken ct = default)
    {
        request ??= new ProposalRequest();
        var clock = Stopwatch.StartNew();
        var model = new QuickModel(index);
        var baseline = model.Evaluate();
        var context = new Context(index, model, derived);

        IEnumerable<Finding> targets = findings.Findings;
        if (request.Finding != null) targets = targets.Where(f => f.Id == request.Finding);
        if (request.Scope != null) targets = targets.Where(f => f.Nodes.Any(id => index.Node(id) is { } n && index.AncestorsAndSelf(n).Any(a => a.Id == request.Scope)));
        var list = targets.ToList();
        if (request.Finding != null && list.Count == 0) throw new ArgumentException($"No finding {request.Finding}.");

        var wanted = request.Kinds is { Count: > 0 } kinds ? kinds : null;
        var candidates = new List<Candidate>();
        foreach (var finding in list)
        {
            ct.ThrowIfCancellationRequested();
            if (clock.Elapsed > request.Budget / 2) break;
            if (Generator(finding.Rule) is not { } generator) continue;
            // Only the kinds that were asked for: a generator that cannot make one is not run at all.
            if (wanted != null && !generator.Kinds.Any(wanted.Contains)) continue;
            candidates.AddRange(generator.Make(context, finding).Where(c => wanted == null || wanted.Contains(c.Kind)).Take(CandidatesPerFinding));
        }

        // The fast model first: how much tangle each structural candidate removes, against its cost. The worst problems
        // are scored first, and only while there is time: what was not scored is not proposed (it needs a gain).
        foreach (var candidate in candidates.OrderByDescending(c => c.Priority))
        {
            if (candidate.Change == null) continue;
            ct.ThrowIfCancellationRequested();
            if (clock.Elapsed > request.Budget * 0.75) break;
            var after = model.Evaluate(candidate.Change);
            candidate.Gain = baseline.Score - after.Score;
        }

        var ranked = candidates
            .Where(c => c.Change == null || c.Gain > 0)
            .GroupBy(c => c.Id, StringComparer.Ordinal).Select(g => g.First())
            .OrderByDescending(c => c.Priority)
            .ThenByDescending(c => c.Gain)
            .ThenBy(c => c.Cost.References)
            .ThenBy(c => c.Id, StringComparer.Ordinal)
            .ToList();

        var result = new List<Proposal>();
        var priorityOf = new Dictionary<string, int>(StringComparer.Ordinal);
        var perTarget = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var candidate in ranked)
        {
            if (result.Count >= request.Limit) break;
            ct.ThrowIfCancellationRequested();
            var target = candidate.Targets.FirstOrDefault() ?? "";
            if (perTarget.GetValueOrDefault(target) >= 2) continue; // the best two ways per finding are enough
            var proposal = candidate.ToProposal();
            if (request.Verify && candidate.Ops.Count > 0 && clock.Elapsed < request.Budget)
            {
                if (!Verify(raw, derived, findings, index, proposal)) continue;
            }
            else if (candidate.Ops.Count > 0)
            {
                proposal.Confidence *= 0.7; // not checked by a simulation
            }

            perTarget[target] = perTarget.GetValueOrDefault(target) + 1;
            priorityOf[proposal.Id] = candidate.Priority;
            result.Add(proposal);
        }

        // Worst problems first; among them the surest fixes.
        return result.OrderByDescending(p => priorityOf[p.Id]).ThenByDescending(p => p.Confidence).ThenBy(p => p.Id, StringComparer.Ordinal).ToList();
    }

    /// <summary>The generator of proposals for a rule's findings, with the kinds of proposals it can make.</summary>
    private static (string[] Kinds, Func<Context, Finding, IEnumerable<Candidate>> Make)? Generator(string rule) => rule switch
    {
        "cycle.project" or "cycle.namespace" or "cycle.type" or "tangle" => (new[] { "break-cycle", "move-type" }, BreakCycle),
        "layer.convention" or "sdp-violation" => (new[] { "invert-dependency" }, InvertLayer),
        "test-dependency" => (new[] { "move-type" }, InvertLayer),
        "feature-envy" => (new[] { "move-member" }, MoveMember),
        "god-class" or "large-type" or "hub" => (new[] { "split-type" }, SplitType),
        "tiny-namespace" or "tiny-project" => (new[] { "merge-namespaces" }, Merge),
        "dead-code" => (new[] { "remove-dead-code" }, RemoveDeadCode),
        "di.captive" or "di.captive-transient" or "di.unregistered" => (new[] { "fix-di" }, FixDi),
        _ => null,
    };

    /// <summary>Simulates a proposal: keeps it when it fixes what it targets without new cycles or errors.</summary>
    private static bool Verify(RawGraph raw, CodeGraph derived, FindingsReport findings, GraphIndex before, Proposal proposal)
    {
        SimulationResult simulated;
        try
        {
            // The simulation's own copy of the graph is derived in place: the raw result is not needed here.
            simulated = Simulator.Run(raw, proposal.Ops, gitFrom: derived, keepRaw: false);
        }
        catch (SimulationException)
        {
            return false;
        }

        var after = new GraphIndex(simulated.Graph);
        var afterFindings = FindingsAnalysis.Compute(simulated.Graph, null, after);
        var diff = GraphDiff.Compare(before, findings, after, afterFindings, NodeLevels.Namespace, maxItems: 200);
        var resolved = diff.Findings.Resolved.Select(f => f.Id).ToList();
        var added = diff.Findings.Added.Where(f => f.Severity != FindingSeverity.Info || f.Rule.StartsWith("cycle", StringComparison.Ordinal)).Select(f => f.Id).ToList();
        var newCycles = diff.Cycles.Sum(c => c.Added.Count);
        var fixedTargets = proposal.Targets.Count(resolved.Contains);
        var shrunk = diff.Cycles.Any(c => c.Changed.Any(x => x.SizeAfter < x.SizeBefore)) || diff.Cycles.Sum(c => c.Before) > diff.Cycles.Sum(c => c.After);
        if (newCycles > 0 || added.Any(a => a.StartsWith("cycle", StringComparison.Ordinal) || a.StartsWith("tangle", StringComparison.Ordinal))) return false;
        if (fixedTargets == 0 && !(proposal.Kind == "break-cycle" && shrunk)) return false;

        proposal.Predicted = new ProposalPrediction(diff.Score.Before, diff.Score.After, resolved, added, diff.Summary);
        proposal.Confidence = Math.Min(1, proposal.Confidence + 0.2 * fixedTargets - 0.1 * added.Count);
        return true;
    }

    // ------------------------------------------------------------------ candidates

    private sealed class Candidate
    {
        public required string Kind { get; init; }
        public required string Key { get; init; }
        public required string Title { get; init; }
        public required string Rationale { get; init; }
        public required List<SimOp> Ops { get; init; }
        public required ProposalCost Cost { get; init; }
        public required List<string> Steps { get; init; }
        public required List<string> Targets { get; init; }
        public double Confidence { get; init; }

        /// <summary>For the fast model; null for changes it cannot judge (DI, dead code, splits).</summary>
        public QuickModel.Change? Change { get; init; }

        /// <summary>Errors before warnings before infos.</summary>
        public int Priority { get; init; }

        public int Gain { get; set; }

        public string Id => $"{Kind}@{Key}";

        public Proposal ToProposal() => new()
        {
            Id = Id, Kind = Kind, Title = Title, Rationale = Rationale, Confidence = Confidence, Ops = Ops, Cost = Cost, Steps = Steps, Targets = Targets,
        };
    }

    private sealed class Context(GraphIndex index, QuickModel model, CodeGraph graph)
    {
        public GraphIndex Index { get; } = index;
        public QuickModel Model { get; } = model;
        public CodeGraph Graph { get; } = graph;

        /// <summary>What may be unused, as a set (made once, not for every dead-code finding).</summary>
        public HashSet<string> Unused => _unused ??= Graph.Analysis.UnusedCandidates.ToHashSet(StringComparer.Ordinal);

        private HashSet<string>? _unused;

        public string Name(string id) => Index.Node(id) is { } n ? n.FullName ?? n.Name : id;
        public string Short(string id) => Index.Node(id)?.Name ?? id;
        public string? At(string id) => Index.Node(id)?.Location is { } l ? $"{l.File}:{l.Line}" : null;

        /// <summary>The places of edges, "file:line", at most n.</summary>
        public List<string> Places(IEnumerable<GraphEdge> edges, int n = 8) =>
            edges.Select(e => Index.Where(e)?.ToString()).Where(p => p != null).Select(p => p!).Distinct().Take(n).ToList();

        public int Files(IEnumerable<GraphEdge> edges, params string[] alsoNodes) =>
            edges.Select(e => Index.Where(e)?.File).Concat(alsoNodes.Select(id => Index.Node(id)?.Location?.File)).Where(f => f != null).Distinct().Count();
    }

    private static int Priority(Finding f) => 3 - FindingSeverity.Order(f.Severity);

    /// <summary>Cutting a cycle: invert each cheap cut dependency, or move the few types that cause it.</summary>
    private static IEnumerable<Candidate> BreakCycle(Context c, Finding finding)
    {
        var level = finding.Rule switch { "cycle.project" => NodeLevels.Project, "cycle.namespace" => NodeLevels.Namespace, _ => NodeLevels.Type };
        var cycle = c.Graph.Analysis.Cycles.FirstOrDefault(x => x.Level == level && x.Nodes.Contains(finding.Nodes.Last()) && finding.Nodes.All(x.Nodes.Contains));
        var members = cycle?.Nodes ?? finding.Nodes.Where(id => c.Index.Node(id) is { } n && NodeLevels.Of(n) == level).ToList();
        var set = members.ToHashSet(StringComparer.Ordinal);
        var inside = (cycle != null ? c.Index.Inside(cycle) : null)
                     ?? c.Index.Dependencies(level).Values.Where(d => set.Contains(d.Source) && set.Contains(d.Target)).ToList();
        var cut = Layering.Compute(set, inside.Select(d => (d.Source, d.Target, d.Weight))).Upward
            .Select(u => c.Index.DependencyBetween(u.Source, u.Target, level)).Where(d => d != null).Select(d => d!)
            .OrderBy(d => d.Weight).ThenBy(d => d.Source, StringComparer.Ordinal).Take(4).ToList();
        if (cut.Count == 0) yield break;

        foreach (var d in cut)
        {
            var inheritance = d.Kinds.Where(k => k.Key is EdgeKinds.Inherits or EdgeKinds.Extends).Sum(k => k.Value);
            if (inheritance < d.Weight) yield return Invert(c, finding, d, "break-cycle", $"Break the cycle: invert {c.Short(d.Source)} → {c.Short(d.Target)}", Priority(finding), 0.6);

            if (level == NodeLevels.Type) continue;
            // The few types on either side that make the dependency: move them across.
            var sources = d.Edges.Select(e => c.Index.TypeOf(e.Source)).Where(t => t != null).Select(t => t!).Distinct().ToList();
            var used = d.Edges.Select(e => c.Index.TypeOf(e.Target)).Where(t => t != null).Select(t => t!).Distinct().ToList();
            if (MoveTypes(c, finding, sources, Home(c, d.Target, level, used), d) is { } forward) yield return forward;
            if (MoveTypes(c, finding, used, Home(c, d.Source, level, sources), d) is { } backward) yield return backward;
        }

        // All cuts at once: the cycle goes in one step.
        if (cut.Count is > 1 and <= 4 && cut.All(d => d.Kinds.Keys.Any(k => k is not (EdgeKinds.Inherits or EdgeKinds.Extends))))
        {
            var parts = cut.Select(d => Invert(c, finding, d, "break-cycle", "", Priority(finding), 0.6)).ToList();
            var change = new QuickModel.Change();
            foreach (var p in parts)
            {
                foreach (var r in p.Change!.Removed) change.Removed.Add(r);
                change.AddedNamespaceEdges.AddRange(p.Change.AddedNamespaceEdges);
            }

            yield return new Candidate
            {
                Kind = "break-cycle",
                Key = $"{finding.Id}/all",
                Title = $"Break the cycle: invert its {cut.Count} cut dependencies",
                Rationale = $"Inverting every dependency of the cheapest cut ({string.Join(", ", cut.Select(d => $"{c.Short(d.Source)} → {c.Short(d.Target)}"))}) leaves no cycle among these {members.Count} {level}s.",
                Ops = parts.SelectMany(p => p.Ops).ToList(),
                Cost = new ProposalCost(parts.Sum(p => p.Cost.References), parts.Sum(p => p.Cost.Files), parts.Sum(p => p.Cost.Members)),
                Steps = parts.SelectMany(p => p.Steps).ToList(),
                Targets = new List<string> { finding.Id },
                Confidence = 0.55,
                Change = change,
                Priority = Priority(finding),
            };
        }
    }

    /// <summary>The namespace where moved types go: the node itself, or (for a project) its namespace the moved types use most.</summary>
    private static string? Home(Context c, string container, string level, List<string> related)
    {
        if (level == NodeLevels.Namespace) return container;
        return related.Select(t => c.Index.NamespaceOf(t)).Where(ns => ns != null && c.Index.ProjectOf(ns) == container)
            .GroupBy(ns => ns!).OrderByDescending(g => g.Count()).Select(g => g.Key).FirstOrDefault()
               ?? c.Graph.Nodes.FirstOrDefault(n => n.Kind == NodeKinds.Namespace && c.Index.ProjectOf(n.Id) == container)?.Id;
    }

    private static Candidate? MoveTypes(Context c, Finding finding, List<string> types, string? to, Dependency because)
    {
        if (to == null || types.Count is 0 or > 3) return null;
        if (types.Any(t => c.Index.Node(t) is not { } n || c.Index.ParentOf(n) is { } p && NodeLevels.IsType(p))) return null;
        var change = new QuickModel.Change();
        if (c.Model.Namespace(to) is not { } target) return null;
        foreach (var t in types)
        {
            if (c.Model.Type(t) is { } i) change.Moves[i] = target;
        }

        var references = types.Sum(t => c.Index.Incoming(t).Count(e => c.Index.TypeOf(e.Source) != t));
        return new Candidate
        {
            Kind = "move-type",
            Key = $"{string.Join("+", types)}→{to}",
            Title = $"Move {string.Join(", ", types.Select(c.Short))} to {c.Short(to)}",
            Rationale = $"{string.Join(", ", types.Select(c.Short))} {(types.Count == 1 ? "makes" : "make")} the dependency {c.Short(because.Source)} → {c.Short(because.Target)} that closes the cycle; in {c.Name(to)} {(types.Count == 1 ? "it sits" : "they sit")} with what {(types.Count == 1 ? "it uses" : "they use")} or what uses {(types.Count == 1 ? "it" : "them")}.",
            Ops = types.Select(t => (SimOp)new MoveTypeOp(t, to)).ToList(),
            Cost = new ProposalCost(references, types.Select(t => c.Index.Node(t)?.Location?.File).Distinct().Count() + Math.Min(references, 20), types.Count),
            Steps = types.Select(t => $"Move {c.Name(t)} ({c.At(t)}) into {c.Name(to)}: change its namespace (and folder), then fix the usings of the {c.Index.Incoming(t).Select(e => c.Index.Where(e)?.File).Distinct().Count()} file(s) that use it.").ToList(),
            Targets = new List<string> { finding.Id },
            Confidence = 0.5,
            Change = change,
            Priority = Priority(finding),
        };
    }

    /// <summary>Dependency inversion of one dependency (or of a layer violation).</summary>
    private static Candidate Invert(Context c, Finding finding, Dependency d, string kind, string title, int priority, double confidence)
    {
        var change = new QuickModel.Change();
        var sources = c.Model.TypesIn(c.Index, d.Source).ToHashSet();
        var targets = c.Model.TypesIn(c.Index, d.Target).ToHashSet();
        foreach (var (s, t, _, _) in c.Model.EdgesBetween(sources, targets))
        {
            change.Removed.Add((s, t));
            // The implementation now points at the interface beside its first user.
            change.AddedNamespaceEdges.Add((c.Model.NamespaceOfType(t), c.Model.NamespaceOfType(s)));
        }

        var targetTypes = d.Edges.Select(e => c.Index.TypeOf(e.Target)).Where(t => t != null).Select(t => t!).Distinct().ToList();
        var members = d.Edges.Where(e => c.Index.Node(e.Target) is { } n && NodeLevels.IsMember(n)).Select(e => c.Short(e.Target)).Distinct().ToList();
        var userNs = d.Edges.Select(e => c.Index.NamespaceOf(e.Source)).FirstOrDefault(ns => ns != null);
        var steps = new List<string>();
        foreach (var type in targetTypes.Take(4))
        {
            var used = d.Edges.Where(e => c.Index.TypeOf(e.Target) == type && c.Index.Node(e.Target) is { } n && NodeLevels.IsMember(n)).Select(e => c.Short(e.Target)).Distinct().ToList();
            steps.Add($"Create interface I{c.Short(type).TrimStart('I')} in {c.Name(userNs ?? d.Source)}{(used.Count > 0 ? $" with {string.Join(", ", used.Take(8))}" : "")}, and make {c.Short(type)} ({c.At(type)}) implement it.");
        }

        steps.Add($"In {c.Name(d.Source)}, depend on the interface{(targetTypes.Count > 1 ? "s" : "")} instead: {string.Join(", ", c.Places(d.Edges))}.");
        var statics = d.Edges.Select(e => c.Index.Node(e.Target)).Where(n => n != null && NodeLevels.IsMember(n)).ToList();
        var allStatic = statics.Count > 0 && statics.All(n => n!.Modifiers?.Contains("static") == true);
        if (allStatic) steps.Add($"What {c.Short(d.Source)} uses is static ({string.Join(", ", statics.Select(n => n!.Name).Distinct().Take(4))}): make it an instance member of the implementation, or pass a function in instead of an interface.");
        steps.Add($"Let the composition root (DI registration, or whoever builds {c.Short(d.Source)}) pass {string.Join(", ", targetTypes.Take(4).Select(c.Short))} in for the interface.");
        return new Candidate
        {
            Kind = kind,
            Key = $"{d.Source}→{d.Target}",
            Title = title.Length > 0 ? title : $"Invert {c.Short(d.Source)} → {c.Short(d.Target)}",
            Rationale = (targetTypes.Count == 1 && targetTypes[0] == d.Target
                    ? $"{c.Name(d.Source)} uses {(members.Count > 0 ? string.Join(", ", members.Take(4)) + " of " : "")}{c.Short(d.Target)} ({d.Weight} references)."
                    : $"{c.Name(d.Source)} uses {string.Join(", ", targetTypes.Take(4).Select(c.Short))} of {c.Name(d.Target)} ({d.Weight} references).")
                + $" With an interface that {c.Short(d.Source)} owns, the dependency points the other way: {c.Short(d.Target)} implements what {c.Short(d.Source)} needs.",
            Ops = new List<SimOp> { new InvertDependencyOp(d.Source, d.Target) },
            Cost = new ProposalCost(d.Weight, c.Files(d.Edges, targetTypes.ToArray()), targetTypes.Count + members.Count),
            Steps = steps,
            Targets = new List<string> { finding.Id },
            Confidence = allStatic ? confidence - 0.2 : confidence,
            Change = change,
            Priority = priority,
        };
    }

    /// <summary>Layer violations (by name, stability, test code): invert the dependency.</summary>
    private static IEnumerable<Candidate> InvertLayer(Context c, Finding finding)
    {
        if (finding.Nodes.Count < 2) yield break;
        var (source, target) = (finding.Nodes[0], finding.Nodes[1]);
        var level = c.Index.Node(source) is { } n ? NodeLevels.Of(n) : NodeLevels.Namespace;
        if (level == NodeLevels.Member) level = NodeLevels.Type;
        if (c.Index.DependencyBetween(source, target, level) is not { } d) yield break;
        var kind = finding.Rule == "test-dependency" ? "move-type" : "invert-dependency";
        if (finding.Rule == "test-dependency")
        {
            var used = d.Edges.Select(e => c.Index.TypeOf(e.Target)).Where(t => t != null).Select(t => t!).Distinct().ToList();
            var home = c.Graph.Nodes.FirstOrDefault(x => x.Kind == NodeKinds.Namespace && c.Index.ProjectOf(x.Id) == c.Index.ProjectOf(source))?.Id;
            if (MoveTypes(c, finding, used, home, d) is { } move) yield return move;
            yield break;
        }

        yield return Invert(c, finding, d, kind, $"Invert {c.Short(source)} → {c.Short(target)}", Priority(finding), 0.6);
    }

    /// <summary>Feature envy: the method goes to the class whose data it uses.</summary>
    private static IEnumerable<Candidate> MoveMember(Context c, Finding finding)
    {
        if (finding.Nodes.Count < 2) yield break;
        var (method, provider) = (finding.Nodes[0], finding.Nodes[1]);
        var callers = c.Index.Incoming(method).Where(e => e.Kind == EdgeKinds.Calls).ToList();
        var change = new QuickModel.Change();
        yield return new Candidate
        {
            Kind = "move-member",
            Key = $"{method}→{provider}",
            Title = $"Move {c.Short(method)} to {c.Short(provider)}",
            Rationale = $"{c.Short(method)} works on the data of {c.Short(provider)} more than on its own class's; next to that data it needs no access to another object's fields.",
            Ops = new List<SimOp> { new MoveMemberOp(method, provider) },
            Cost = new ProposalCost(callers.Sum(e => e.Weight) + 1, c.Files(callers, method, provider), 1),
            Steps = new List<string>
            {
                $"Move {c.Short(method)} ({c.At(method)}) into {c.Name(provider)} ({c.At(provider)}); what it reads of {c.Short(provider)} becomes its own fields.",
                callers.Count == 0 ? "Nothing in the analyzed code calls it." : $"Update its {callers.Count} caller(s): {string.Join(", ", c.Places(callers))}.",
            },
            Targets = new List<string> { finding.Id },
            Confidence = 0.55,
            Priority = Priority(finding),
        };
    }

    /// <summary>God classes, large types and hubs: split along the clusters of members that work together.</summary>
    private static IEnumerable<Candidate> SplitType(Context c, Finding finding)
    {
        var typeId = finding.Nodes[0];
        if (c.Index.Node(typeId) is not { } type || !NodeLevels.IsType(type) && !ClassMetrics.IsClass(type)) yield break;
        var groups = MemberClusters.Find(c.Index, typeId);
        if (groups.Count < 2) yield break;

        // The biggest group stays; each other one becomes a type named after what its members are about.
        var parts = groups.OrderByDescending(g => g.Count).Skip(1).Where(g => g.Count >= 2).Take(4).ToList();
        if (parts.Count == 0) yield break;
        var names = new HashSet<string>(StringComparer.Ordinal) { type.Name };
        var split = parts.Select((g, i) => new SplitPart(MemberClusters.Name(type.Name, g.Select(id => c.Short(id)), names, i + 2), g.Select(id => id).ToList())).ToList();
        var moved = parts.Sum(g => g.Count);
        var callers = parts.SelectMany(g => g).SelectMany(id => c.Index.Incoming(id)).Where(e => c.Index.TypeOf(e.Source) != typeId).ToList();
        yield return new Candidate
        {
            Kind = "split-type",
            Key = typeId,
            Title = $"Split {type.Name} into {type.Name}, {string.Join(", ", split.Select(p => p.Name))}",
            Rationale = $"The members of {type.Name} fall into {groups.Count} groups that call each other and share fields within the group but hardly across (modularity clustering of calls and field use): each group is a responsibility of its own.",
            Ops = new List<SimOp> { new SplitTypeOp(typeId, split) },
            Cost = new ProposalCost(callers.Sum(e => e.Weight), c.Files(callers, typeId), moved),
            Steps = split.Select(p => $"Create {p.Name} beside {type.Name} ({c.At(typeId)}) and move {string.Join(", ", p.Members.Take(10).Select(id => c.Short(id)))}{(p.Members.Count > 10 ? $" and {p.Members.Count - 10} more" : "")} into it.")
                .Append(callers.Count == 0 ? $"{type.Name} keeps the rest; nothing outside it calls the moved members." : $"{type.Name} keeps the rest; callers of the moved members switch to the new types: {string.Join(", ", c.Places(callers))}.")
                .ToList(),
            Targets = new List<string> { finding.Id },
            Confidence = 0.5,
            Priority = Priority(finding),
        };
    }

    /// <summary>Tiny namespaces and projects: into the module they belong with.</summary>
    private static IEnumerable<Candidate> Merge(Context c, Finding finding)
    {
        if (finding.Nodes.Count < 2) yield break;
        var (module, partner) = (finding.Nodes[0], finding.Nodes[1]);
        if (finding.Rule == "tiny-namespace")
        {
            var types = c.Index.TypesIn(module, NodeLevels.Namespace).Select(n => n.Id).ToList();
            var change = new QuickModel.Change();
            if (c.Model.Namespace(partner) is { } target)
            {
                foreach (var t in types)
                {
                    if (c.Model.Type(t) is { } i) change.Moves[i] = target;
                }
            }

            yield return new Candidate
            {
                Kind = "merge-namespaces",
                Key = $"{module}→{partner}",
                Title = $"Merge {c.Short(module)} into {c.Short(partner)}",
                Rationale = finding.Message,
                Ops = new List<SimOp> { new MergeNamespacesOp(module, partner) },
                Cost = new ProposalCost(types.Sum(t => c.Index.Incoming(t).Count), types.Count, types.Count),
                Steps = types.Select(t => $"Move {c.Short(t)} ({c.At(t)}) into {c.Name(partner)} and drop {c.Name(module)}.").ToList(),
                Targets = new List<string> { finding.Id },
                Confidence = 0.6,
                Priority = Priority(finding),
            };
            yield break;
        }

        var namespaces = c.Graph.Nodes.Where(n => n.Kind == NodeKinds.Namespace && c.Index.ProjectOf(n.Id) == module).Select(n => n.Id).ToList();
        if (namespaces.Count == 0) yield break;
        yield return new Candidate
        {
            Kind = "merge-namespaces",
            Key = $"{module}→{partner}",
            Title = $"Fold project {c.Short(module)} into {c.Short(partner)}",
            Rationale = finding.Message,
            Ops = namespaces.Select(ns => (SimOp)new MoveNamespaceOp(ns, partner)).ToList(),
            Cost = new ProposalCost(namespaces.Count, namespaces.Count + 2, namespaces.Count),
            Steps = new List<string> { $"Move the code of {c.Short(module)} into {c.Short(partner)}, remove the project and its references." },
            Targets = new List<string> { finding.Id },
            Confidence = 0.45,
            Priority = Priority(finding),
        };
    }

    private static IEnumerable<Candidate> RemoveDeadCode(Context c, Finding finding)
    {
        var owner = finding.Nodes[0];
        var unused = c.Unused;
        var nodes = unused.Contains(owner) ? new List<string> { owner } : finding.Nodes.Skip(1).ToList();
        if (nodes.Count == 0) yield break;
        var confidence = nodes.Select(id => c.Index.Node(id)?.Accessibility).All(a => a is "private") ? 0.8 : 0.6;
        yield return new Candidate
        {
            Kind = "remove-dead-code",
            Key = owner,
            Title = nodes.Count == 1 ? $"Delete {c.Short(nodes[0])}" : $"Delete {nodes.Count} unused members of {c.Short(owner)}",
            Rationale = $"Nothing in the analyzed code references {(nodes.Count == 1 ? c.Name(nodes[0]) : string.Join(", ", nodes.Take(6).Select(c.Short)))}.",
            Ops = nodes.Select(id => (SimOp)new RemoveNodeOp(id)).ToList(),
            Cost = new ProposalCost(0, nodes.Select(id => c.Index.Node(id)?.Location?.File).Distinct().Count(), nodes.Count),
            Steps = nodes.Take(10).Select(id => $"Delete {c.Short(id)} ({c.At(id)}), after checking that nothing outside the analyzed code (reflection, serialization, other repositories) uses it.").ToList(),
            Targets = new List<string> { finding.Id },
            Confidence = confidence,
            Priority = Priority(finding),
        };
    }

    private static IEnumerable<Candidate> FixDi(Context c, Finding finding)
    {
        if (finding.Nodes.Count < 2 || c.Graph.Analysis.Di is not { } di) yield break;
        var (consumer, service) = (finding.Nodes[0], finding.Nodes[1]);
        var registration = di.Registrations.FirstOrDefault(r => r.Implementation == consumer || r.Service == consumer);
        if (finding.Rule == "di.unregistered")
        {
            yield return new Candidate
            {
                Kind = "fix-di",
                Key = $"{consumer}→{service}",
                Title = $"Register {c.Short(service)}",
                Rationale = finding.Message,
                Ops = new List<SimOp>(),
                Cost = new ProposalCost(1, 1, 0),
                Steps = new List<string> { $"Register {c.Short(service)} with the container where the other services are registered{(di.Registrations.FirstOrDefault()?.Location is { } where ? $" ({where.File}:{where.Line})" : "")}, or stop asking for it in {c.Short(consumer)} ({c.At(consumer)})." },
                Targets = new List<string> { finding.Id },
                Confidence = 0.7,
                Priority = Priority(finding),
            };
            yield break;
        }

        var lifetime = di.Dependencies.FirstOrDefault(d => d.Consumer == consumer && (d.Service == service || d.Implementations.Contains(service)))?.Lifetime;
        if (lifetime is not ("scoped" or "transient")) lifetime = Tags.DiScoped;
        yield return new Candidate
        {
            Kind = "fix-di",
            Key = $"{consumer}→{service}",
            Title = $"Make {c.Short(consumer)} {lifetime}",
            Rationale = $"{c.Short(consumer)} lives longer than the {c.Short(service)} it holds. With the same lifetime as {c.Short(service)}, each scope gets its own pair.",
            Ops = new List<SimOp> { new SetLifetimeOp(consumer, lifetime) },
            Cost = new ProposalCost(1, 1, 0),
            Steps = new List<string>
            {
                $"Register {c.Short(consumer)} as {lifetime}{(registration?.Location is { } l ? $" ({l.File}:{l.Line})" : "")}.",
                $"If {c.Short(consumer)} has to stay a {registration?.Lifetime ?? "singleton"} (a hosted service, a cache), inject IServiceScopeFactory instead and create a scope each time it needs {c.Short(service)}.",
            },
            Targets = new List<string> { finding.Id },
            Confidence = 0.7,
            Priority = Priority(finding),
        };
    }
}

/// <summary>
/// Groups the members of a type by how they work together: Clauset–Newman–Moore greedy modularity on a graph of its
/// members, joined by calls between them and by the fields they share.
/// </summary>
internal static class MemberClusters
{
    public static List<List<string>> Find(GraphIndex index, string typeId)
    {
        var members = index.Children(typeId).Where(m => NodeLevels.IsMember(m) && m.Kind is not NodeKinds.Constructor).Select(m => m.Id).ToList();
        if (members.Count < 4 || members.Count > 400) return new List<List<string>>();
        var at = members.Select((id, i) => (id, i)).ToDictionary(p => p.id, p => p.i, StringComparer.Ordinal);
        var weight = new Dictionary<(int, int), double>();
        void Link(int a, int b, double w)
        {
            if (a == b) return;
            var key = a < b ? (a, b) : (b, a);
            weight[key] = weight.GetValueOrDefault(key) + w;
        }

        foreach (var id in members)
        {
            foreach (var edge in index.Outgoing(id))
            {
                if (at.TryGetValue(edge.Target, out var j)) Link(at[id], j, 1);
            }
        }

        if (weight.Count == 0) return new List<List<string>>();

        // Greedy agglomeration: merge the pair of communities that raises modularity most, while it does.
        var total = weight.Values.Sum();
        var community = Enumerable.Range(0, members.Count).ToArray();
        var degree = new double[members.Count];
        foreach (var ((a, b), w) in weight)
        {
            degree[a] += w;
            degree[b] += w;
        }

        var between = new Dictionary<(int, int), double>(weight);
        var communityDegree = degree.ToArray();
        while (true)
        {
            var best = (Gain: 0.0, A: -1, B: -1);
            foreach (var ((a, b), w) in between)
            {
                var gain = w / total - 2 * communityDegree[a] * communityDegree[b] / (4 * total * total);
                if (gain > best.Gain + 1e-12 || Math.Abs(gain - best.Gain) <= 1e-12 && best.A >= 0 && (a, b).CompareTo((best.A, best.B)) < 0 && gain > 0) best = (gain, a, b);
            }

            if (best.A < 0) break;
            var (keep, drop) = (best.A, best.B);
            for (var i = 0; i < community.Length; i++) if (community[i] == drop) community[i] = keep;
            communityDegree[keep] += communityDegree[drop];
            communityDegree[drop] = 0;
            var merged = new Dictionary<(int, int), double>();
            foreach (var ((a, b), w) in between)
            {
                var (x, y) = (a == drop ? keep : a, b == drop ? keep : b);
                if (x == y) continue;
                var key = x < y ? (x, y) : (y, x);
                merged[key] = merged.GetValueOrDefault(key) + w;
            }

            between = merged;
        }

        // Members linked to nothing join the group they share the most outside types with: here, simply the largest.
        var groups = community.Select((c, i) => (c, i)).GroupBy(p => p.c).Select(g => g.Select(p => members[p.i]).ToList()).ToList();
        var linked = groups.Where(g => g.Count > 1).OrderByDescending(g => g.Count).ToList();
        if (linked.Count == 0) return new List<List<string>>();
        foreach (var single in groups.Where(g => g.Count == 1)) linked[0].Add(single[0]);
        return linked.OrderByDescending(g => g.Count).ThenBy(g => g[0], StringComparer.Ordinal).ToList();
    }

    private static readonly Regex Words = new("[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\\d+", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Noise = new(StringComparer.OrdinalIgnoreCase) { "get", "set", "is", "has", "to", "from", "on", "async", "by", "with", "for", "the", "and", "or", "of", "try", "do", "can", "should" };

    /// <summary>A name for a group: its most common word, and the role word of the type (OrderService → PricingService).</summary>
    public static string Name(string typeName, IEnumerable<string> memberNames, HashSet<string> taken, int fallback)
    {
        var word = memberNames
            .SelectMany(n => Words.Matches(n.TrimStart('_')).Select(m => m.Value))
            .Where(w => w.Length > 2 && !Noise.Contains(w))
            .GroupBy(w => char.ToUpperInvariant(w[0]) + w[1..].ToLowerInvariant())
            .OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal)
            .Select(g => g.Key).FirstOrDefault(w => !typeName.Contains(w, StringComparison.OrdinalIgnoreCase));
        var role = Words.Matches(typeName).Select(m => m.Value).LastOrDefault() ?? typeName;
        var name = word != null ? word + (role.Equals(typeName, StringComparison.Ordinal) ? typeName : role) : $"{typeName}Part{fallback}";
        for (var n = 2; !taken.Add(name); n++) name = $"{name}{n}";
        return name;
    }
}
