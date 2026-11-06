using CodeMap.Model;

namespace CodeMap.Insights;

public static partial class FindingsAnalysis
{
    private static readonly HashSet<string> CodeMembers = new(StringComparer.Ordinal) { NodeKinds.Method, NodeKinds.Function, NodeKinds.Constructor, NodeKinds.Property };

    /// <summary>Roles whose job is to pass calls on: not middle men.</summary>
    private static readonly string[] DelegatingRoles = { Tags.Controller, Tags.Page, Tags.Component, Tags.Hub, Tags.Handler, Tags.Middleware };

    /// <summary>Long and large types, long and complex methods, long parameter lists.</summary>
    private static void Sizes(Context c)
    {
        var o = c.Options;
        var god = c.Findings.Where(f => f.Rule == "god-class").Select(f => f.Nodes[0]).ToHashSet(StringComparer.Ordinal);

        // Types, and classes inside files (TypeScript); a file is not flagged again for a large class it holds.
        var units = c.Graph.Nodes.Where(n => !c.Skip(n) && (NodeLevels.IsType(n) || NodeLevels.IsMember(n) && ClassMetrics.IsClass(n))).ToList();
        var large = new HashSet<string>(StringComparer.Ordinal);
        foreach (var unit in units.OrderByDescending(u => NodeLevels.IsMember(u)))
        {
            var loc = unit.Metric("loc");
            var members = unit.Metric("members");
            if (god.Contains(unit.Id) || loc < o.LargeTypeLoc && members < o.LargeTypeMembers) continue;
            if (unit.Metric("complexity") < loc / 50) continue; // tables, constants, declarations: data, not logic
            if (NodeLevels.IsType(unit) && c.Index.Children(unit.Id).Any(child => large.Contains(child.Id))) continue;
            large.Add(unit.Id);
            c.Add("large-type", unit.Id, loc >= 2 * o.LargeTypeLoc ? FindingSeverity.Warning : FindingSeverity.Info, $"{unit.Name} is large",
                $"{c.Name(unit.Id)} has {Plural(loc, "line")} and {Plural(members, "member")}.",
                impact: loc / 10,
                nodes: new[] { unit.Id },
                locations: new[] { c.At(unit.Id) },
                evidence: Evidence(("loc", loc), ("loc.limit", o.LargeTypeLoc), ("members", members), ("members.limit", o.LargeTypeMembers)),
                suggestion: "Split it into types that each have one reason to change.");
        }

        // Not the code at the top of a file ("(top-level)"): it is not a method to split.
        foreach (var member in c.Graph.Nodes.Where(n => NodeLevels.IsMember(n) && CodeMembers.Contains(n.Kind) && !n.Name.StartsWith('(') && !c.Skip(n)))
        {
            var loc = member.Metric("loc");
            var leaf = !c.Index.Children(member.Id).Any(NodeLevels.IsMember);
            var complexity = member.Metric("complexity");
            var parameters = member.Metric("parameters");
            if (loc >= o.LongMethodLoc)
            {
                c.Add("long-method", member.Id, loc >= 2 * o.LongMethodLoc ? FindingSeverity.Warning : FindingSeverity.Info, $"{c.Short(member.Id)} is long",
                    $"{c.Short(member.Id)} has {Plural(loc, "line")}.",
                    impact: loc / 10,
                    nodes: new[] { member.Id },
                    locations: new[] { c.At(member.Id) },
                    evidence: Evidence(("loc", loc), ("loc.limit", o.LongMethodLoc)),
                    suggestion: "Extract its steps into well-named methods.");
            }

            if (leaf && complexity >= o.ComplexMethod)
            {
                c.Add("complex-method", member.Id, complexity >= 25 ? FindingSeverity.Warning : FindingSeverity.Info, $"{c.Short(member.Id)} is complex",
                    $"{c.Short(member.Id)} has a cyclomatic complexity of {F(complexity)}: that many paths through it to understand and test.",
                    impact: complexity,
                    nodes: new[] { member.Id },
                    locations: new[] { c.At(member.Id) },
                    evidence: Evidence(("complexity", complexity), ("complexity.limit", o.ComplexMethod)),
                    suggestion: "Replace nested conditions with early returns, extract the branches, or use polymorphism / a lookup table for the cases.");
            }

            if (member.Kind is NodeKinds.Method or NodeKinds.Function && parameters >= o.ManyParameters)
            {
                c.Add("many-parameters", member.Id, FindingSeverity.Info, $"{c.Short(member.Id)} has {F(parameters)} parameters",
                    $"{c.Short(member.Id)} takes {F(parameters)} parameters.",
                    impact: parameters,
                    nodes: new[] { member.Id },
                    locations: new[] { c.At(member.Id) },
                    evidence: Evidence(("parameters", parameters), ("parameters.limit", o.ManyParameters)),
                    suggestion: "Group the parameters that travel together into a parameter object.");
            }
        }
    }

    /// <summary>Deep chains of base classes inside the analyzed code.</summary>
    private static void Inheritance(Context c)
    {
        var baseOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var edge in c.Graph.Edges.Where(e => e.Kind == EdgeKinds.Inherits))
        {
            if (c.Index.Node(edge.Source) is { } source && ClassMetrics.IsClass(source) && c.Index.Node(edge.Target) is { External: false } target && ClassMetrics.IsClass(target))
            {
                baseOf.TryAdd(source.Id, target.Id);
            }
        }

        var bases = baseOf.Values.ToHashSet(StringComparer.Ordinal);
        foreach (var leaf in baseOf.Keys.Where(id => !bases.Contains(id)))
        {
            if (c.Skip(leaf)) continue;
            var chain = new List<string> { leaf };
            for (var current = leaf; baseOf.TryGetValue(current, out var next) && !chain.Contains(next); current = next) chain.Add(next);
            var depth = chain.Count - 1;
            if (depth < c.Options.DeepInheritance) continue;
            c.Add("deep-inheritance", leaf, FindingSeverity.Info, $"{c.Short(leaf)} has {depth} levels of base classes",
                $"{string.Join(" → ", chain.Select(c.Short))}: behaviour is spread over {depth + 1} classes.",
                impact: depth,
                nodes: chain,
                locations: new[] { c.At(leaf) },
                evidence: Evidence(("depth", depth), ("depth.limit", c.Options.DeepInheritance)),
                suggestion: "Prefer composition: move the shared behaviour into collaborators the classes hold, and flatten the chain.");
        }
    }

    /// <summary>Classes whose methods just pass calls on to one other class (decorators and request handlers are not).</summary>
    private static void MiddleMen(Context c)
    {
        foreach (var type in c.Graph.Nodes.Where(n => ClassMetrics.IsClass(n) && !c.Skip(n) && !DelegatingRoles.Any(n.HasTag)))
        {
            var methods = c.Index.Children(type.Id).Where(m => m.Kind is NodeKinds.Method or NodeKinds.Function && m.Modifiers?.Contains("static") != true).ToList();
            if (methods.Count < c.Options.MiddleManMethods) continue;

            var delegatedTo = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var method in methods)
            {
                if (method.Metric("complexity") > 1 || method.Metric("loc") > 5) continue;
                var calls = c.Index.Outgoing(method.Id).Where(e => e.Kind == EdgeKinds.Calls).ToList();
                if (calls.Count != 1 || calls[0].Weight != 1 || c.Index.Node(calls[0].Target) is not { } target || target.Parent == type.Id || target.Parent == null) continue;
                delegatedTo[target.Parent] = delegatedTo.GetValueOrDefault(target.Parent) + 1;
            }

            var delegating = delegatedTo.Values.Sum();
            if (delegating < c.Options.MiddleManShare * methods.Count) continue;
            var (main, count) = delegatedTo.OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal).First();
            if (count < c.Options.MiddleManShare * delegating) continue;

            // A decorator or adapter shares an interface with what it wraps, or derives from it: that is its purpose.
            var own = Contracts(c, type.Id);
            if (own.Overlaps(Contracts(c, main)) || own.Contains(main)) continue;

            c.Add("middle-man", type.Id, FindingSeverity.Info, $"{type.Name} only passes calls on",
                $"{count} of the {methods.Count} methods of {c.Name(type.Id)} only call {c.Short(main)}.",
                impact: count,
                nodes: new[] { type.Id, main },
                locations: new[] { c.At(type.Id) },
                evidence: Evidence(("methods", methods.Count), ("delegating", count), ("share", (double)count / methods.Count), ("share.limit", c.Options.MiddleManShare)),
                suggestion: $"Let the callers use {c.Short(main)} directly and remove {type.Name}, unless it is meant to hide it (then give it behaviour of its own).");
        }
    }

    /// <summary>Base classes and interfaces a type has (one level).</summary>
    private static HashSet<string> Contracts(Context c, string typeId) =>
        c.Index.Outgoing(typeId).Where(e => e.Kind is EdgeKinds.Implements or EdgeKinds.Inherits).Select(e => e.Target).ToHashSet(StringComparer.Ordinal);

    /// <summary>Interfaces that something uses but nothing in the analyzed code implements.</summary>
    private static void UnimplementedInterfaces(Context c)
    {
        foreach (var type in c.Graph.Nodes.Where(n => n.Kind == NodeKinds.Interface && !c.Skip(n) && n.Metric("ca") > 0))
        {
            if (type.Attributes != null || c.Index.Children(type.Id).Any(m => m.Attributes != null)) continue;
            var implemented = c.Index.Incoming(type.Id).Any(e => e.Kind is EdgeKinds.Implements or EdgeKinds.Inherits or EdgeKinds.Extends && e.Source != type.Id);
            if (implemented) continue;
            var users = c.Index.DependentsOf(type.Id, NodeLevels.Type).Select(d => c.Short(d.Source)).ToList();
            c.Add("unimplemented-interface", type.Id, FindingSeverity.Info, $"Nothing implements {type.Name}",
                $"{c.Name(type.Id)} is used by {List(users, 4)}, but no class in the analyzed code implements it.",
                impact: users.Count,
                nodes: new[] { type.Id },
                locations: new[] { c.At(type.Id) },
                evidence: Evidence(("users", users.Count)),
                suggestion: "If it is implemented outside the analyzed code, nothing to do; otherwise remove the interface and its uses, or add the implementation.");
        }
    }
}
