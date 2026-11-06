using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Insights;

public static partial class FindingsAnalysis
{
    /// <summary>What git shows: hidden change coupling, shotgun surgery, hotspots.</summary>
    private static void History(Context c)
    {
        var o = c.Options;
        var pairs = c.Graph.Analysis.ChangeCoupling.Where(p => !c.Skip(p.Source) && !c.Skip(p.Target)).ToList();
        foreach (var pair in pairs.Where(p => p.Hidden && p.SharedCommits >= o.HiddenCouplingMinShared && p.Strength >= o.HiddenCouplingMinStrength))
        {
            var strong = pair.Strength >= 0.8 && pair.SharedCommits >= 5;
            c.Add("change-coupling.hidden", $"{pair.Source}→{pair.Target}", strong ? FindingSeverity.Warning : FindingSeverity.Info,
                $"{c.Short(pair.Source)} and {c.Short(pair.Target)} change together",
                $"{c.Name(pair.Source)} and {c.Name(pair.Target)} changed in the same {Plural(pair.SharedCommits, "commit")} (strength {F(pair.Strength)}), but neither depends on the other in the code.",
                impact: pair.SharedCommits * pair.Strength,
                nodes: new[] { pair.Source, pair.Target },
                locations: new[] { c.At(pair.Source), c.At(pair.Target) },
                evidence: Evidence(("sharedCommits", pair.SharedCommits), ("strength", pair.Strength), ("strength.limit", o.HiddenCouplingMinStrength)),
                suggestion: "Find the assumption they share (a duplicated rule, a format, a mapping) and give it one home that both use.");
        }

        var partners = pairs.SelectMany(p => new[] { (p.Source, p.Target, p.SharedCommits), (p.Target, p.Source, p.SharedCommits) })
            .GroupBy(p => p.Item1, StringComparer.Ordinal);
        foreach (var group in partners)
        {
            var list = group.OrderByDescending(p => p.SharedCommits).ThenBy(p => p.Item2, StringComparer.Ordinal).ToList();
            if (list.Count < o.ShotgunSurgeryPartners) continue;
            c.Add("shotgun-surgery", group.Key, FindingSeverity.Info, $"Changing {c.Short(group.Key)} means changing {list.Count} other types",
                $"{c.Name(group.Key)} keeps changing together with {List(list.Select(p => c.Short(p.Item2)), 5)} ({list.Count} types in all, git).",
                impact: list.Count,
                nodes: new[] { group.Key }.Concat(list.Select(p => p.Item2)),
                locations: new[] { c.At(group.Key) },
                evidence: Evidence(("partners", list.Count), ("partners.limit", o.ShotgunSurgeryPartners), ("sharedCommits", list.Sum(p => p.SharedCommits))),
                suggestion: "Gather the knowledge these changes keep touching into one place (move members or types next to each other).");
        }

        foreach (var type in c.Graph.Nodes.Where(n => n.HasTag(Tags.Hotspot) && n.Metric("commits") >= o.HotspotMinCommits && !c.Skip(n)))
        {
            var (score, complexity, commits) = (type.Metric("hotspot"), type.Metric("complexity"), type.Metric("commits"));
            c.Add("hotspot", type.Id, FindingSeverity.Warning, $"{type.Name} is a hotspot",
                $"{c.Name(type.Id)} is complex (complexity {F(complexity)}) and changes often ({Plural(commits, "commit")}, {Plural(type.Metric("authors"), "author")}): where bugs and effort concentrate.",
                impact: score * 100,
                nodes: new[] { type.Id },
                locations: new[] { c.At(type.Id) },
                evidence: Evidence(("hotspot", score), ("complexity", complexity), ("commits", commits), ("churn", type.Metric("churn")), ("authors", type.Metric("authors"))),
                suggestion: "Simplify it first: split it along its responsibilities and cover the parts that keep changing with tests.");
        }
    }

    /// <summary>The DI analysis's issues, circular wiring and constructors that ask for too much.</summary>
    private static void DependencyInjection(Context c)
    {
        var di = c.Graph.Analysis.Di;
        if (di == null) return;

        FindingLocation? Registration(string service) =>
            di.Registrations.FirstOrDefault(r => r.Service == service || r.Implementation == service) is { Location: { } l } r
                ? new FindingLocation { File = l.File, Line = l.Line, Node = r.RegisteredIn, Note = $"registers {c.Short(r.Service)} as {r.Lifetime}" }
                : null;

        foreach (var issue in di.Issues)
        {
            if (c.Skip(issue.Consumer)) continue;
            var title = issue.Kind switch
            {
                "captive" => $"{c.Short(issue.Consumer)} holds a shorter-lived {c.Short(issue.Service)}",
                "captive-transient" => $"{c.Short(issue.Consumer)} holds the transient {c.Short(issue.Service)}",
                "unregistered" => $"{c.Short(issue.Service)} is not registered",
                "scope-bubbling" => $"Request scope spreads to {c.Short(issue.Consumer)}",
                "interface-injection" => $"{c.Short(issue.Consumer)} injects the interface {c.Short(issue.Service)} without a token",
                "unreachable" => $"{c.Short(issue.Consumer)} cannot reach {c.Short(issue.Service)}",
                _ => $"{issue.Kind}: {c.Short(issue.Consumer)} → {c.Short(issue.Service)}",
            };
            c.Add("di." + issue.Kind, $"{issue.Consumer}→{issue.Service}", issue.Severity, title, issue.Message,
                impact: 10,
                nodes: new[] { issue.Consumer, issue.Service },
                locations: new[] { c.At(issue.Consumer, "the consumer"), Registration(issue.Consumer), Registration(issue.Service) },
                suggestion: issue.Kind switch
                {
                    "captive" or "captive-transient" => $"Give {c.Short(issue.Consumer)} the shorter lifetime, or let it create a scope (IServiceScopeFactory) / take a factory for {c.Short(issue.Service)}.",
                    "unregistered" => $"Register {c.Short(issue.Service)} with the container, or stop asking for it.",
                    _ => null,
                },
                category: FindingCategory.Di);
        }

        // The container's wiring: consumer → what it gets injected.
        var wiring = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var dependency in di.Dependencies)
        {
            foreach (var implementation in dependency.Implementations.Where(i => i != dependency.Consumer))
            {
                if (!wiring.TryGetValue(dependency.Consumer, out var set)) wiring[dependency.Consumer] = set = new HashSet<string>(StringComparer.Ordinal);
                set.Add(implementation);
            }
        }

        foreach (var cycle in CycleDetector.FindCycles(wiring))
        {
            var nodes = cycle.OrderBy(id => id, StringComparer.Ordinal).ToList();
            if (nodes.All(c.Skip)) continue;
            c.Add("di.circular", nodes[0], FindingSeverity.Error, $"Circular dependency between {nodes.Count} services",
                $"{List(nodes.Select(c.Short))} need each other through their constructors: the container cannot build any of them.",
                impact: nodes.Count * 10,
                nodes: nodes,
                locations: nodes.Select(id => c.At(id)),
                evidence: Evidence(("size", nodes.Count)),
                suggestion: "Break the circle: move the shared part into a third service both use, or take a factory / Lazy<T> for one direction.",
                category: FindingCategory.Di);
        }

        foreach (var group in di.Dependencies.GroupBy(d => d.Consumer, StringComparer.Ordinal))
        {
            var services = group.Select(d => d.Service + "|" + d.Key).Distinct(StringComparer.Ordinal).Count();
            if (services < c.Options.OverInjection || c.Skip(group.Key)) continue;
            c.Add("di.over-injection", group.Key, services >= 10 ? FindingSeverity.Warning : FindingSeverity.Info,
                $"{c.Short(group.Key)} asks for {services} services",
                $"The constructor of {c.Name(group.Key)} takes {services} services ({List(group.Select(d => c.Short(d.Service)).Distinct(), 5)}): a sign of too many responsibilities.",
                impact: services,
                nodes: new[] { group.Key },
                locations: new[] { c.At(group.Key) },
                evidence: Evidence(("services", services), ("services.limit", c.Options.OverInjection)),
                suggestion: "Split the class by the services each of its jobs needs, or group services that are always used together behind a facade.",
                category: FindingCategory.Di);
        }
    }

    /// <summary>Unused code, one finding per type.</summary>
    private static void DeadCode(Context c)
    {
        var unused = c.Graph.Analysis.UnusedCandidates.Where(id => !c.Skip(id)).ToHashSet(StringComparer.Ordinal);
        foreach (var group in unused.GroupBy(id => c.Index.TypeOf(id) ?? id, StringComparer.Ordinal).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var owner = group.Key;
            var wholeType = unused.Contains(owner);
            var members = group.Where(id => id != owner).OrderBy(id => id, StringComparer.Ordinal).ToList();
            var loc = (wholeType ? c.Index.Node(owner)?.Metric("loc") : members.Sum(id => c.Index.Node(id)?.Metric("loc") ?? 0)) ?? 0;
            var title = wholeType ? $"{c.Short(owner)} is not used" : $"{Plural(members.Count, "member")} of {c.Short(owner)} {(members.Count == 1 ? "is" : "are")} not used";
            var message = wholeType
                ? $"Nothing in the analyzed code references {c.Name(owner)}{(loc > 0 ? $" ({Plural(loc, "line")})" : "")}."
                : $"Nothing references {List(members.Select(c.Short), 8)}.";
            c.Add("dead-code", owner, FindingSeverity.Info, title, message,
                impact: Math.Log2(1 + loc) + members.Count,
                nodes: new[] { owner }.Concat(members),
                locations: (wholeType ? new List<string> { owner } : members).Select(id => c.At(id)),
                evidence: Evidence(("members", wholeType ? c.Index.Children(owner).Count(NodeLevels.IsMember) : members.Count), ("loc", loc)),
                suggestion: wholeType ? $"Delete {c.Short(owner)} if nothing outside the analyzed code (reflection, configuration, other repositories) uses it." : "Delete them if nothing outside the analyzed code (reflection, serialization, other repositories) uses them.");
        }
    }

    /// <summary>The diagnostics of the checks inside function bodies (--checks), one finding each.</summary>
    private static void CodeChecks(Context c)
    {
        var ordinal = new Dictionary<(string, string), int>();
        foreach (var d in c.Graph.Analysis.Diagnostics ?? new List<CodeDiagnostic>())
        {
            if (d.Node != null && c.Skip(d.Node)) continue;
            var where = d.Node ?? d.Location.File;
            var n = ordinal[(d.Rule, where)] = ordinal.GetValueOrDefault((d.Rule, where)) + 1;
            var rule = "code." + d.Rule;
            c.Add(rule, n == 1 ? where : $"{where}#{n}", d.Severity,
                $"{d.Rule} in {(d.Node != null ? c.Short(d.Node) : d.Location.File)}",
                d.Message,
                impact: 1,
                nodes: d.Node != null ? new[] { d.Node } : Array.Empty<string>(),
                locations: new[] { new FindingLocation { File = d.Location.File, Line = d.Location.Line, EndLine = d.Location.EndLine > d.Location.Line ? d.Location.EndLine : 0, Node = d.Node, Note = d.Source == "compiler" ? "compiler" : null } },
                evidence: Evidence(("line", d.Location.Line), ("column", d.Column)),
                category: FindingCategory.Code,
                proposalKinds: Array.Empty<string>());
        }
    }
}
