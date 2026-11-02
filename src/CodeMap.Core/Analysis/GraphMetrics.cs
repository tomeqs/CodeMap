using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>
/// Derives metrics and findings from a finished graph: size, complexity, coupling (Ca/Ce),
/// instability, abstractness, distance from the main sequence, dependency cycles and dead-code candidates.
/// </summary>
internal static class GraphMetrics
{
    private static readonly HashSet<string> StructuralEdges = new() { EdgeKinds.ProjectReference, EdgeKinds.PackageReference };

    /// <param name="unusedPolicy">Which nodes may be reported as unused (the policy of their language; null = none).</param>
    public static void Compute(CodeGraph graph, Func<GraphNode, UnusedPolicy?> unusedPolicy)
    {
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        var children = graph.Nodes.Where(n => n.Parent != null).ToLookup(n => n.Parent!, StringComparer.Ordinal);

        string? TypeOf(string id)
        {
            if (!byId.TryGetValue(id, out var node) || node.External && !NodeLevels.IsType(node)) return null;
            if (NodeLevels.IsType(node)) return node.Id;
            return NodeLevels.IsMember(node) && node.Parent != null ? TypeOf(node.Parent) : null;
        }

        string? NamespaceOf(string id)
        {
            for (var current = byId.GetValueOrDefault(id); current != null; current = current.Parent != null ? byId.GetValueOrDefault(current.Parent) : null)
            {
                if (current.Kind == NodeKinds.Namespace) return current.Id;
            }

            return null;
        }

        // ---------------------------------------------------------- member level
        var callers = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var callees = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var edge in graph.Edges.Where(e => e.Kind == EdgeKinds.Calls && e.Source != e.Target))
        {
            Add(callers, edge.Target, edge.Source);
            Add(callees, edge.Source, edge.Target);
        }

        foreach (var node in graph.Nodes.Where(NodeLevels.IsMember))
        {
            if (callers.TryGetValue(node.Id, out var inbound)) node.SetMetric("fanIn", inbound.Count);
            if (callees.TryGetValue(node.Id, out var outbound)) node.SetMetric("fanOut", outbound.Count);
        }

        // ---------------------------------------------------------- type level
        var typeDeps = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var typeDependents = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var subclasses = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var edge in graph.Edges)
        {
            if (StructuralEdges.Contains(edge.Kind)) continue;
            var source = TypeOf(edge.Source);
            var target = TypeOf(edge.Target);
            if (source == null || target == null || source == target) continue;
            if (byId[source].External || byId[target].External) continue;
            Add(typeDeps, source, target);
            Add(typeDependents, target, source);
            if (edge.Kind == EdgeKinds.Inherits && NodeLevels.IsType(byId[edge.Source]))
            {
                subclasses[target] = subclasses.GetValueOrDefault(target) + 1;
            }
        }

        var types = graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External).ToList();
        foreach (var type in types)
        {
            var members = children[type.Id].Where(NodeLevels.IsMember).ToList();
            type.SetMetric("members", members.Count);
            SetIfPositive(type, "methods", members.Count(m => m.Kind == NodeKinds.Method));
            SetIfPositive(type, "constructors", members.Count(m => m.Kind == NodeKinds.Constructor));
            SetIfPositive(type, "properties", members.Count(m => m.Kind == NodeKinds.Property));
            SetIfPositive(type, "fields", members.Count(m => m.Kind == NodeKinds.Field));
            SetIfPositive(type, "events", members.Count(m => m.Kind == NodeKinds.Event));

            var behavioural = members.Where(m => m.Kind is NodeKinds.Method or NodeKinds.Constructor or NodeKinds.Property or NodeKinds.Event).ToList();
            type.SetMetric("complexity", behavioural.Sum(m => m.Metric("complexity")));
            if (behavioural.Count > 0) type.SetMetric("maxComplexity", behavioural.Max(m => m.Metric("complexity")));

            var ce = typeDeps.TryGetValue(type.Id, out var deps) ? deps.Count : 0;
            var ca = typeDependents.TryGetValue(type.Id, out var dependents) ? dependents.Count : 0;
            type.SetMetric("ce", ce);
            type.SetMetric("ca", ca);
            type.SetMetric("instability", ca + ce == 0 ? 0 : Math.Round((double)ce / (ca + ce), 3));
            SetIfPositive(type, "noc", subclasses.GetValueOrDefault(type.Id));
        }

        // ---------------------------------------------------------- namespace & project level
        var nsDeps = Roll(typeDeps, NamespaceOf);
        var projectDeps = Roll(typeDeps, id => byId[id].Project);

        AggregateContainers(graph.Nodes.Where(n => n.Kind == NodeKinds.Namespace), types, t => NamespaceOf(t.Id), nsDeps);
        AggregateContainers(graph.Nodes.Where(n => n.Kind == NodeKinds.Project), types, t => t.Project, projectDeps);

        // ---------------------------------------------------------- cycles
        foreach (var cycle in CycleDetector.FindCycles(typeDeps))
        {
            graph.Analysis.Cycles.Add(new CycleInfo { Level = "type", Nodes = cycle });
            foreach (var id in cycle) byId[id].AddTag(Tags.InCycle);
        }

        foreach (var cycle in CycleDetector.FindCycles(nsDeps))
        {
            graph.Analysis.Cycles.Add(new CycleInfo { Level = "namespace", Nodes = cycle });
            foreach (var id in cycle) byId[id].AddTag(Tags.InCycle);
        }

        foreach (var cycle in CycleDetector.FindCycles(projectDeps))
        {
            graph.Analysis.Cycles.Add(new CycleInfo { Level = "project", Nodes = cycle });
            foreach (var id in cycle) byId[id].AddTag(Tags.InCycle);
        }

        graph.Analysis.Cycles.Sort((a, b) => b.Nodes.Count.CompareTo(a.Nodes.Count));

        // ---------------------------------------------------------- dead code candidates
        DetectUnused(graph, byId, children, unusedPolicy);

        // ---------------------------------------------------------- rankings
        graph.Analysis.MostComplex = types
            .Where(t => t.Metric("complexity") > 0)
            .OrderByDescending(t => t.Metric("complexity"))
            .Take(25)
            .Select(t => new RankedItem { Id = t.Id, Score = t.Metric("complexity") })
            .ToList();
        graph.Analysis.MostDepended = types
            .Where(t => t.Metric("ca") > 0)
            .OrderByDescending(t => t.Metric("ca"))
            .Take(25)
            .Select(t => new RankedItem { Id = t.Id, Score = t.Metric("ca") })
            .ToList();
    }

    /// <summary>Combines git churn with complexity: complex code that changes often is where bugs live.</summary>
    public static void ComputeHotspots(CodeGraph graph)
    {
        var types = graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && n.Metric("commits") > 0).ToList();
        if (types.Count == 0) return;
        var maxComplexity = Math.Max(1, types.Max(t => t.Metric("complexity")));
        var maxCommits = Math.Max(1, types.Max(t => t.Metric("commits")));
        foreach (var type in types)
        {
            var score = Math.Sqrt(type.Metric("complexity") / maxComplexity * (type.Metric("commits") / maxCommits));
            type.SetMetric("hotspot", Math.Round(score, 3));
        }

        var ranked = types.Where(t => t.Metric("hotspot") > 0).OrderByDescending(t => t.Metric("hotspot")).Take(25).ToList();
        graph.Analysis.Hotspots = ranked.Select(t => new RankedItem { Id = t.Id, Score = t.Metric("hotspot") }).ToList();
        foreach (var type in ranked.Take(10).Where(t => t.Metric("hotspot") >= 0.25)) type.AddTag(Tags.Hotspot);
    }

    private static void AggregateContainers(IEnumerable<GraphNode> containers, List<GraphNode> types, Func<GraphNode, string?> containerOf,
        Dictionary<string, HashSet<string>> deps)
    {
        var typesByContainer = types.Where(t => containerOf(t) != null).ToLookup(t => containerOf(t)!, StringComparer.Ordinal);
        var dependents = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var (source, targets) in deps)
        {
            foreach (var target in targets) Add(dependents, target, source);
        }

        foreach (var container in containers)
        {
            var own = typesByContainer[container.Id].ToList();
            // Nested types are inside their parent's span; only count top-level types for size.
            var ownIds = own.Select(o => o.Id).ToHashSet(StringComparer.Ordinal);
            var topLevel = own.Where(t => t.Parent == null || !ownIds.Contains(t.Parent)).ToList();
            container.SetMetric("types", own.Count);
            container.SetMetric("loc", topLevel.Sum(t => t.Metric("loc")));
            container.SetMetric("complexity", own.Sum(t => t.Metric("complexity")));

            var abstractCount = own.Count(t => t.Kind == NodeKinds.Interface || t.Modifiers?.Contains("abstract") == true);
            var abstractness = own.Count == 0 ? 0 : (double)abstractCount / own.Count;
            var ce = deps.TryGetValue(container.Id, out var d) ? d.Count : 0;
            var ca = dependents.TryGetValue(container.Id, out var a) ? a.Count : 0;
            var instability = ca + ce == 0 ? 0 : (double)ce / (ca + ce);
            container.SetMetric("ce", ce);
            container.SetMetric("ca", ca);
            container.SetMetric("abstractness", Math.Round(abstractness, 3));
            container.SetMetric("instability", Math.Round(instability, 3));
            container.SetMetric("distance", Math.Round(Math.Abs(abstractness + instability - 1), 3));
        }
    }

    private static void DetectUnused(CodeGraph graph, Dictionary<string, GraphNode> byId, ILookup<string, GraphNode> children,
        Func<GraphNode, UnusedPolicy?> policyOf)
    {
        // The type-level node a node belongs to (itself for types; members are inside one).
        string? OwnerType(string id)
        {
            var node = byId.GetValueOrDefault(id);
            if (node == null || !NodeLevels.IsMember(node)) return id;
            while (node != null && NodeLevels.IsMember(node)) node = node.Parent != null ? byId.GetValueOrDefault(node.Parent) : null;
            return node?.Id;
        }

        var referenced = new HashSet<string>(StringComparer.Ordinal);
        var referencedTypes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var edge in graph.Edges)
        {
            if (edge.Kind is EdgeKinds.Implements or EdgeKinds.Overrides) referenced.Add(edge.Source); // reachable through the contract
            if (edge.Source == edge.Target) continue;
            referenced.Add(edge.Target);

            // A type counts as used when anything outside of it points at it or at one of its members.
            var targetType = OwnerType(edge.Target);
            var sourceType = OwnerType(edge.Source);
            if (targetType != null && targetType != sourceType) referencedTypes.Add(targetType);
        }

        var projectIsTest = graph.Nodes.Where(n => n.Kind == NodeKinds.Project && n.HasTag(Tags.TestProject)).Select(n => n.Id).ToHashSet();

        foreach (var node in graph.Nodes)
        {
            if (node.External || node.Project == null || projectIsTest.Contains(node.Project)) continue;
            var policy = policyOf(node);
            if (policy is not { Enabled: true }) continue;
            if (policy.SkipAttributed && node.Attributes != null || policy.SkipTags.Any(node.HasTag)) continue;

            var parent = node.Parent != null ? byId.GetValueOrDefault(node.Parent) : null;
            bool isCandidate;
            if (NodeLevels.IsMember(node))
            {
                if (policy.MemberAccessibility != null && !policy.MemberAccessibility.Contains(node.Accessibility ?? "")) continue;
                if (policy.SkipMemberKinds.Contains(node.Kind) || node.Modifiers?.Any(policy.SkipModifiers.Contains) == true) continue;
                if (policy.SkipNames.Contains(node.Name) || policy.SkipNamePattern?.IsMatch(node.Name) == true) continue;
                if (parent != null && (policy.SkipParentKinds.Contains(parent.Kind) || policy.SkipParentTags.Any(parent.HasTag))) continue;
                isCandidate = !referenced.Contains(node.Id);
            }
            else if (NodeLevels.IsType(node))
            {
                if (policy.TypeAccessibility != null && !policy.TypeAccessibility.Contains(node.Accessibility ?? "")) continue;
                if (policy.SkipTypeTags.Any(node.HasTag)) continue;
                isCandidate = !referencedTypes.Contains(node.Id) && !children[node.Id].Any(c => referencedTypes.Contains(c.Id));
            }
            else
            {
                continue;
            }

            if (isCandidate)
            {
                node.AddTag(Tags.Unused);
                graph.Analysis.UnusedCandidates.Add(node.Id);
            }
        }
    }

    private static Dictionary<string, HashSet<string>> Roll(Dictionary<string, HashSet<string>> deps, Func<string, string?> map)
    {
        var result = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var (source, targets) in deps)
        {
            var s = map(source);
            if (s == null) continue;
            foreach (var target in targets)
            {
                var t = map(target);
                if (t != null && t != s) Add(result, s, t);
            }
        }

        return result;
    }

    private static void Add(Dictionary<string, HashSet<string>> map, string key, string value)
    {
        if (!map.TryGetValue(key, out var set)) map[key] = set = new HashSet<string>(StringComparer.Ordinal);
        set.Add(value);
    }

    private static void SetIfPositive(GraphNode node, string metric, double value)
    {
        if (value > 0) node.SetMetric(metric, value);
    }
}
