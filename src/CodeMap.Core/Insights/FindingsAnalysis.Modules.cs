using System.Text.RegularExpressions;
using CodeMap.Model;

namespace CodeMap.Insights;

public static partial class FindingsAnalysis
{
    /// <summary>Clean / onion architecture by name: 0 the core, 3 the outermost delivery layer.</summary>
    private static readonly Dictionary<string, (int Rank, string Layer)> LayerNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["domain"] = (0, "domain"), ["core"] = (0, "domain"), ["entities"] = (0, "domain"), ["entity"] = (0, "domain"), ["kernel"] = (0, "domain"),
        ["application"] = (1, "application"), ["usecases"] = (1, "application"),
        ["infrastructure"] = (2, "infrastructure"), ["infra"] = (2, "infrastructure"), ["persistence"] = (2, "infrastructure"),
        ["data"] = (2, "infrastructure"), ["dataaccess"] = (2, "infrastructure"), ["repositories"] = (2, "infrastructure"), ["storage"] = (2, "infrastructure"),
        ["web"] = (3, "presentation"), ["api"] = (3, "presentation"), ["ui"] = (3, "presentation"), ["presentation"] = (3, "presentation"),
        ["controllers"] = (3, "presentation"), ["host"] = (3, "presentation"), ["frontend"] = (3, "presentation"),
    };

    /// <summary>Test helpers the test detection does not catch (setupTests.ts, sidebar.test.helpers.tsx, FakeClock).</summary>
    private static readonly Regex TestLikeName = new(@"test|spec|mock|fixture|fake|stub", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private static readonly Regex NameParts = new(@"[./\\@:_\-\s]+", RegexOptions.CultureInvariant);

    /// <summary>The layer a module's name puts it in: the last part of the name that names a layer.</summary>
    private static (int Rank, string Layer)? LayerOf(GraphNode node)
    {
        var parts = NameParts.Split(node.FullName ?? node.Name);
        for (var i = parts.Length - 1; i >= 0; i--)
        {
            if (LayerNames.TryGetValue(parts[i], out var layer)) return layer;
        }

        return null;
    }

    /// <summary>Inner layers (by name) that depend on outer ones.</summary>
    private static void LayerConventions(Context c)
    {
        var reported = new HashSet<(string, string)>();
        foreach (var level in new[] { NodeLevels.Project, NodeLevels.Namespace })
        {
            foreach (var dependency in c.Index.Dependencies(level).Values.OrderByDescending(d => d.Weight))
            {
                if (c.Skip(dependency.Source) || c.Skip(dependency.Target)) continue;
                var source = c.Index.Node(dependency.Source)!;
                var target = c.Index.Node(dependency.Target)!;
                if (LayerOf(source) is not { } from || LayerOf(target) is not { } to || from.Rank >= to.Rank) continue;

                // A namespace pair inside a project pair already reported is the same problem.
                if (level == NodeLevels.Namespace)
                {
                    var projects = (c.Index.ProjectOf(source.Id) ?? "", c.Index.ProjectOf(target.Id) ?? "");
                    if (reported.Contains(projects)) continue;
                }

                reported.Add((source.Id, target.Id));
                c.Add("layer.convention", $"{source.Id}→{target.Id}", FindingSeverity.Warning,
                    $"{source.Name} ({from.Layer}) depends on {target.Name} ({to.Layer})",
                    $"By their names, {c.Name(source.Id)} is the {from.Layer} layer and {c.Name(target.Id)} the {to.Layer} layer, which should depend on it, not the other way round. {c.Describe(dependency)}.",
                    impact: dependency.Weight,
                    nodes: new[] { source.Id, target.Id },
                    locations: c.At(dependency, c.Options.MaxLocations),
                    evidence: Evidence(("weight", dependency.Weight), ("sourceRank", from.Rank), ("targetRank", to.Rank)),
                    suggestion: $"Define what {source.Name} needs as an interface in {source.Name} and implement it in {target.Name} (dependency inversion), or move the code that needs {target.Name} out of {source.Name}.");
            }
        }
    }

    /// <summary>The level whose modules are judged by Martin's metrics: projects when there are several, else namespaces.</summary>
    private static string ModuleLevel(Context c) =>
        c.Graph.Nodes.Count(n => n.Kind == NodeKinds.Project && !c.Skip(n)) >= 3 ? NodeLevels.Project : NodeLevels.Namespace;

    private static IEnumerable<GraphNode> Modules(Context c, string level) =>
        c.Graph.Nodes.Where(n => n.Kind == (level == NodeLevels.Project ? NodeKinds.Project : NodeKinds.Namespace) && !c.Skip(n) && n.Metric("types") > 0);

    /// <summary>Stable dependencies, and modules far from the main sequence.</summary>
    private static void MainSequence(Context c)
    {
        var o = c.Options;
        var level = ModuleLevel(c);
        var unit = level == NodeLevels.Project ? "project" : "namespace";
        var modules = Modules(c, level).ToDictionary(n => n.Id, StringComparer.Ordinal);

        foreach (var dependency in c.Index.Dependencies(level).Values)
        {
            if (!modules.TryGetValue(dependency.Source, out var source) || !modules.TryGetValue(dependency.Target, out var target)) continue;
            if (source.Metric("ca") + source.Metric("ce") < 3 || target.Metric("ca") + target.Metric("ce") < 3) continue;
            var (si, ti) = (source.Metric("instability"), target.Metric("instability"));
            if (ti - si < o.SdpMargin) continue;
            c.Add("sdp-violation", $"{source.Id}→{target.Id}", FindingSeverity.Info,
                $"{source.Name} depends on the less stable {target.Name}",
                $"{c.Name(source.Id)} (instability {F(si)}) depends on {c.Name(target.Id)} (instability {F(ti)}): the stable {unit} will have to change when the volatile one does. {c.Describe(dependency)}.",
                impact: (ti - si) * 10 + Math.Log2(1 + dependency.Weight),
                nodes: new[] { source.Id, target.Id },
                locations: c.At(dependency, 3),
                evidence: Evidence(("sourceInstability", si), ("targetInstability", ti), ("margin", o.SdpMargin), ("weight", dependency.Weight)),
                suggestion: $"Depend on an abstraction that {source.Name} owns (or that lives in a stable {unit}) instead of {target.Name} itself.");
        }

        foreach (var module in modules.Values)
        {
            var (a, i, d, types) = (module.Metric("abstractness"), module.Metric("instability"), module.Metric("distance"), module.Metric("types"));
            if (types >= o.ZoneMinTypes && a <= 0.2 && i <= 0.2 && d >= 0.6 && module.Metric("ca") >= 3)
            {
                c.Add("zone-of-pain", module.Id, FindingSeverity.Info, $"{module.Name} is in the zone of pain",
                    $"{c.Name(module.Id)} is concrete (abstractness {F(a)}) and many depend on it (instability {F(i)}): hard to change without breaking its users.",
                    impact: d * 10,
                    nodes: new[] { module.Id },
                    locations: new[] { c.At(module.Id) },
                    evidence: Evidence(("abstractness", a), ("instability", i), ("distance", d), ("types", types)),
                    suggestion: "Give its users interfaces to depend on, or keep it to stable, rarely changing code (value types, DTOs).");
            }
            else if (types >= 3 && a >= 0.8 && i >= 0.8)
            {
                c.Add("zone-of-uselessness", module.Id, FindingSeverity.Info, $"{module.Name} is in the zone of uselessness",
                    $"{c.Name(module.Id)} is mostly abstractions (abstractness {F(a)}) that little depends on (instability {F(i)}).",
                    impact: d * 10,
                    nodes: new[] { module.Id },
                    locations: new[] { c.At(module.Id) },
                    evidence: Evidence(("abstractness", a), ("instability", i), ("distance", d), ("types", types)),
                    suggestion: "Remove the abstractions nobody uses, or move them next to their users.");
            }
        }
    }

    /// <summary>Namespaces with one type and projects with one or two, mostly coupled to one other module.</summary>
    private static void TinyModules(Context c)
    {
        var o = c.Options;
        foreach (var level in new[] { NodeLevels.Namespace, NodeLevels.Project })
        {
            var kind = level == NodeLevels.Project ? NodeKinds.Project : NodeKinds.Namespace;
            var all = c.Graph.Nodes.Where(n => n.Kind == kind && !c.Skip(n)).ToList();
            var maxTypes = level == NodeLevels.Project ? 2 : o.TinyTypes;
            foreach (var module in all)
            {
                var types = module.Metric("types");
                if (types == 0 || types > maxTypes) continue;

                List<GraphNode> siblings;
                if (level == NodeLevels.Namespace)
                {
                    // Leaf namespaces only; not a namespace chosen on purpose (extension methods in Microsoft.*), not
                    // folders of a language whose types are files (one component per folder is the convention there).
                    if (module.Name == "(global)" || module.Name.StartsWith("Microsoft.", StringComparison.Ordinal) || module.Name.StartsWith("System.", StringComparison.Ordinal)) continue;
                    if (c.Index.Children(module.Id).Any(n => n.Kind == NodeKinds.Namespace || n.Kind == NodeKinds.Module)) continue;
                    var project = c.Index.ProjectOf(module.Id);
                    siblings = all.Where(n => c.Index.ProjectOf(n.Id) == project).ToList();
                }
                else
                {
                    if (module.Metric("ca") == 0 || c.Index.Children(module.Id).Any(n => c.Index.Children(n.Id).Any(t => t.HasTag(Tags.EntryPoint)) || n.HasTag(Tags.EntryPoint))) continue;
                    siblings = all;
                }

                if (siblings.Count < 3) continue;
                var weights = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var d in c.Index.DependenciesOf(module.Id, level)) weights[d.Target] = weights.GetValueOrDefault(d.Target) + d.Weight;
                foreach (var d in c.Index.DependentsOf(module.Id, level)) weights[d.Source] = weights.GetValueOrDefault(d.Source) + d.Weight;
                var candidates = weights.Where(w => siblings.Any(s => s.Id == w.Key && s.Name != "(global)")).ToList();
                var total = candidates.Sum(w => w.Value);
                if (total == 0) continue;
                var (partner, weight) = candidates.OrderByDescending(w => w.Value).ThenBy(w => w.Key, StringComparer.Ordinal).First();
                var share = (double)weight / total;
                if (share < o.TinyPartnerShare) continue;

                var held = c.Index.TypesIn(module.Id, level).Select(n => n.Id).ToList();
                var rule = level == NodeLevels.Project ? "tiny-project" : "tiny-namespace";
                var unit = level == NodeLevels.Project ? "project" : "namespace";
                c.Add(rule, module.Id, FindingSeverity.Info, $"{module.Name} is a tiny {unit}",
                    $"{c.Name(module.Id)} holds {Plural(types, "type")} ({List(held.Select(c.Short), 3)}), and {Math.Round(share * 100)}% of its dependencies are with {c.Name(partner)}.",
                    impact: share * 5,
                    nodes: new[] { module.Id, partner }.Concat(held),
                    locations: held.Select(id => c.At(id)),
                    evidence: Evidence(("types", types), ("partnerShare", share), ("partnerWeight", weight)),
                    suggestion: $"Move {List(held.Select(c.Short), 3)} into {c.Index.Node(partner)?.Name ?? partner} and remove {module.Name}.");
            }
        }
    }

    /// <summary>Production code that depends on test code.</summary>
    private static void TestDependencies(Context c)
    {
        var reported = new HashSet<(string, string)>();
        foreach (var level in new[] { NodeLevels.Project, NodeLevels.Type })
        {
            foreach (var dependency in c.Index.Dependencies(level).Values)
            {
                if (c.Index.Node(dependency.Source) is not { } source || c.Index.Node(dependency.Target) is not { } target) continue;
                if (c.Index.IsTest(source) || !c.Index.IsTest(target) || c.Index.IsGenerated(source) || TestLikeName.IsMatch(source.Name)) continue;
                var projects = (c.Index.ProjectOf(source.Id) ?? "", c.Index.ProjectOf(target.Id) ?? "");
                if (level == NodeLevels.Type && reported.Contains(projects)) continue;
                reported.Add(level == NodeLevels.Project ? (source.Id, target.Id) : projects);
                c.Add("test-dependency", $"{source.Id}→{target.Id}", FindingSeverity.Error,
                    $"{source.Name} depends on test code ({target.Name})",
                    $"{c.Name(source.Id)} is production code but depends on {c.Name(target.Id)}, which is test code. {c.Describe(dependency)}.",
                    impact: dependency.Weight,
                    nodes: new[] { source.Id, target.Id },
                    locations: c.At(dependency, c.Options.MaxLocations),
                    evidence: Evidence(("weight", dependency.Weight)),
                    suggestion: $"Move what {source.Name} needs out of the tests into production code, or move {source.Name} into the tests.");
            }
        }
    }
}
