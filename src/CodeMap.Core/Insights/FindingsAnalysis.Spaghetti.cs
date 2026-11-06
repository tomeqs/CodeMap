using CodeMap.Analysis;
using CodeMap.Model;

namespace CodeMap.Insights;

public static partial class FindingsAnalysis
{
    private static readonly string[] EnvyExempt = { Tags.Extensions, Tags.Controller, Tags.Page, Tags.Component, Tags.Validator, Tags.Factory, Tags.Dto };

    /// <summary>Cycles of every level, each with the cheapest cut that breaks it and the code behind the cut.</summary>
    private static void Cycles(Context c)
    {
        foreach (var cycle in c.Graph.Analysis.Cycles)
        {
            var nodes = cycle.Nodes.Where(id => c.Index.Node(id) != null).OrderBy(id => id, StringComparer.Ordinal).ToList();
            if (nodes.Count < 2 || nodes.All(c.Skip)) continue;

            var level = cycle.Level;
            var rule = level switch
            {
                NodeLevels.Project => "cycle.project",
                NodeLevels.Namespace => "cycle.namespace",
                _ => nodes.Count >= c.Options.TangleSize ? "tangle" : "cycle.type",
            };
            var severity = rule switch
            {
                "cycle.project" or "tangle" => FindingSeverity.Error,
                "cycle.type" when nodes.Count == 2 => FindingSeverity.Info,
                _ => FindingSeverity.Warning,
            };

            var members = nodes.ToHashSet(StringComparer.Ordinal);
            var inside = c.Index.Dependencies(level).Values.Where(d => members.Contains(d.Source) && members.Contains(d.Target)).ToList();
            var cut = Layering.Compute(nodes, inside.Select(d => (d.Source, d.Target, d.Weight))).Upward
                .Select(u => c.Index.DependencyBetween(u.Source, u.Target, level))
                .Where(d => d != null).Select(d => d!)
                .OrderByDescending(d => d.Weight).ThenBy(d => d.Source, StringComparer.Ordinal).ThenBy(d => d.Target, StringComparer.Ordinal)
                .ToList();
            var cutWeight = cut.Sum(d => d.Weight);
            var totalWeight = inside.Sum(d => d.Weight);

            var unit = level switch { NodeLevels.Project => "project", NodeLevels.Namespace => "namespace", _ => "type" };
            var title = rule == "tangle" ? $"Tangle of {nodes.Count} types" : $"Cycle between {nodes.Count} {unit}s";
            var cutText = cut.Count == 0 ? ""
                : $" Cutting {Plural(cut.Count, "dependency", "dependencies")} ({cutWeight} of its {Plural(totalWeight, "reference")}) breaks it: {List(cut.Select(d => $"{c.Short(d.Source)} → {c.Short(d.Target)}"), 4)}.";
            var message = $"{List(nodes.Select(c.Short))} depend on each other in a circle.{cutText}";
            var suggestion = level == NodeLevels.Type
                ? "Break the cut references: depend on an interface the lower type owns, pass the data instead of the object, raise an event, or merge the types if they are one concept."
                : $"Make the cut dependencies point down: move the types that cause them, or invert them (an interface in the lower {unit}, implemented above it).";

            c.Add(rule, nodes[0], severity, title, message,
                impact: nodes.Count * 10 + cutWeight,
                nodes: cut.SelectMany(d => new[] { d.Source, d.Target }).Concat(nodes),
                locations: cut.SelectMany(d => c.At(d, 3)),
                evidence: Evidence(("size", nodes.Count), ("cutDependencies", cut.Count), ("cutWeight", cutWeight), ("totalWeight", totalWeight)),
                facts: cut.Take(8).Select(c.Describe).ToList(),
                suggestion: suggestion);
        }
    }

    /// <summary>Types in the top of the codebase both for what uses them and for what they use.</summary>
    private static void Hubs(Context c)
    {
        var types = c.Types.Where(t => t.Metric("ca") + t.Metric("ce") > 0).ToList();
        if (types.Count == 0) return;
        var caLimit = Math.Max(c.Options.HubMinCa, Percentile(types.Select(t => t.Metric("ca")).ToList(), c.Options.HubPercentile));
        var ceLimit = Math.Max(c.Options.HubMinCe, Percentile(types.Select(t => t.Metric("ce")).ToList(), c.Options.HubPercentile));
        foreach (var type in types.Where(t => t.Metric("ca") >= caLimit && t.Metric("ce") >= ceLimit))
        {
            var ca = type.Metric("ca");
            var ce = type.Metric("ce");
            var users = c.Index.DependentsOf(type.Id, NodeLevels.Type).OrderByDescending(d => d.Weight).Select(d => c.Short(d.Source));
            var uses = c.Index.DependenciesOf(type.Id, NodeLevels.Type).OrderByDescending(d => d.Weight).Select(d => c.Short(d.Target));
            c.Add("hub", type.Id, FindingSeverity.Warning, $"{type.Name} is a hub",
                $"{c.Name(type.Id)} is used by {Plural(ca, "type")} and uses {Plural(ce, "type")}: changes reach it from both sides and spread from it.",
                impact: ca + ce,
                nodes: new[] { type.Id },
                locations: new[] { c.At(type.Id) },
                evidence: Evidence(("ca", ca), ("ca.limit", caLimit), ("ce", ce), ("ce.limit", ceLimit)),
                facts: new List<string> { $"Used most by {List(users, 5)}.", $"Uses most {List(uses, 5)}." },
                suggestion: "Split it by the groups of users it serves, and let it depend on abstractions instead of the concrete types it uses.");
        }
    }

    /// <summary>Lanza–Marinescu god classes and methods with feature envy.</summary>
    private static void GodClassesAndEnvy(Context c)
    {
        var o = c.Options;
        foreach (var (id, stats) in c.Classes.Classes)
        {
            var type = c.Index.Node(id)!;
            if (c.Skip(type)) continue;

            var methods = c.Index.Children(id).Where(m => c.Classes.Method(m.Id) != null).ToList();
            if (stats.Wmc >= o.GodClassWmc && stats.Atfd > o.GodClassAtfd && stats.Tcc < o.GodClassTcc)
            {
                var providers = methods.Select(m => c.Classes.Method(m.Id)!.Provider).Where(p => p != null).Select(p => p!)
                    .GroupBy(p => p, StringComparer.Ordinal).OrderByDescending(g => g.Count()).Select(g => c.Short(g.Key)).ToList();
                c.Add("god-class", id, FindingSeverity.Warning, $"{type.Name} is a god class",
                    $"{c.Name(id)} is complex (WMC {F(stats.Wmc)}), works on the data of other classes ({stats.Atfd} attributes{(providers.Count > 0 ? $", mostly of {List(providers, 3)}" : "")}) and its {stats.Methods} methods share little data of their own (TCC {F(Math.Round(stats.Tcc, 2))}).",
                    impact: stats.Wmc,
                    nodes: new[] { id },
                    locations: new[] { c.At(id) },
                    evidence: Evidence(("wmc", stats.Wmc), ("wmc.limit", o.GodClassWmc), ("atfd", stats.Atfd), ("atfd.limit", o.GodClassAtfd), ("tcc", stats.Tcc), ("tcc.limit", o.GodClassTcc), ("methods", stats.Methods)),
                    suggestion: "Split it along the groups of methods that work on the same data, and move the code that works on other classes' data to those classes.");
            }

            // Mapping data is the job of presentation code, validators, factories and mappers.
            if (EnvyExempt.Any(type.HasTag) || type.Name.EndsWith("Mapper", StringComparison.Ordinal) || type.Name.EndsWith("Profile", StringComparison.Ordinal)) continue;
            foreach (var method in methods)
            {
                var m = c.Classes.Method(method.Id)!;
                if (m.Atfd <= o.FeatureEnvyAtfd || m.Laa >= o.FeatureEnvyLaa || m.Fdp > o.FeatureEnvyFdp || m.Provider == null || c.Skip(method)) continue;
                if (c.Index.Node(m.Provider)?.HasTag(Tags.Dto) == true) continue; // filling or reading a data object is its purpose
                c.Add("feature-envy", method.Id, FindingSeverity.Info, $"{c.Short(method.Id)} envies {c.Short(m.Provider)}",
                    $"{c.Short(method.Id)} uses {Plural(m.Atfd, "attribute")} of {(m.Fdp > 1 ? $"{c.Short(m.Provider)} and one other class" : c.Short(m.Provider))} but {(m.OwnAttributes == 0 ? "none" : $"only {m.OwnAttributes}")} of its own class.",
                    impact: m.Atfd,
                    nodes: new[] { method.Id, m.Provider },
                    locations: new[] { c.At(method.Id) },
                    evidence: Evidence(("atfd", m.Atfd), ("atfd.limit", o.FeatureEnvyAtfd), ("laa", m.Laa), ("laa.limit", o.FeatureEnvyLaa), ("fdp", m.Fdp), ("fdp.limit", o.FeatureEnvyFdp)),
                    suggestion: $"Move {method.Name} (or the part of it that works on that data) to {c.Short(m.Provider)}.");
            }
        }
    }
}
