using System.Globalization;
using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>One part of the <see cref="HealthScore"/>: how bad it is (0 good … 1 bad), its weight, and why.</summary>
public sealed class HealthComponent
{
    public required string Name { get; init; }

    /// <summary>The most points this part can take off (the weights add up to 100).</summary>
    public required double Weight { get; init; }

    /// <summary>0 (nothing wrong) to 1 (as bad as it counts).</summary>
    public required double Value { get; init; }

    /// <summary>Points taken off: weight × value.</summary>
    public required double Penalty { get; init; }

    public required string Explanation { get; init; }
}

/// <summary>
/// A grade for the structure, out of 100: 100 − (25·cycles + 20·layers + 20·coupling + 20·findings + 15·size), each
/// part from 0 to 1, with the numbers that set it. A (85+), B (70+), C (55+), D (40+), E.
/// </summary>
public sealed class HealthScore
{
    public required int Score { get; init; }

    /// <summary>A–E.</summary>
    public required string Grade { get; init; }

    public required List<HealthComponent> Components { get; init; }

    /// <summary>One line: the score and what costs the most.</summary>
    public required string Summary { get; init; }

    public static HealthScore Compute(GraphIndex index, FindingOptions options, IReadOnlyList<Finding> findings)
    {
        var graph = index.Graph;
        bool Counted(GraphNode n) => !n.External && (options.IncludeTests || !index.IsTest(n)) && (options.IncludeGenerated || !index.IsGenerated(n));
        var types = graph.Nodes.Where(n => NodeLevels.IsType(n) && Counted(n)).ToList();
        var namespaces = graph.Nodes.Where(n => n.Kind == NodeKinds.Namespace && Counted(n) && n.Metric("types") > 0).ToList();
        var projects = graph.Nodes.Where(n => n.Kind == NodeKinds.Project && Counted(n)).ToList();
        string P(double v) => (v * 100).ToString("0", CultureInfo.InvariantCulture) + "%";
        string N(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);

        // Cycles: the share of namespaces and of types caught in cycles, and any project cycle.
        HashSet<string> InCycles(string level) => graph.Analysis.Cycles.Where(c => c.Level == level).SelectMany(c => c.Nodes).ToHashSet(StringComparer.Ordinal);
        var nsShare = Share(namespaces, InCycles(NodeLevels.Namespace));
        var typeShare = Share(types, InCycles(NodeLevels.Type));
        var projectShare = Share(projects, InCycles(NodeLevels.Project));
        var cycles = Clamp(0.5 * nsShare + 0.5 * Math.Min(1, 3 * typeShare) + projectShare);

        // Layers: the share of the dependency weight between namespaces (else projects) that points up.
        var layering = graph.Analysis.Layers.FirstOrDefault(l => l.Level == NodeLevels.Namespace) ?? graph.Analysis.Layers.FirstOrDefault();
        var layerLevel = layering?.Level ?? NodeLevels.Namespace;
        var total = index.Dependencies(layerLevel).Values.Sum(d => d.Weight);
        var upward = layering?.Upward.Sum(e => e.Weight) ?? 0;
        var upShare = total == 0 ? 0 : (double)upward / total;
        var layers = Clamp(4 * upShare);

        // Coupling: distance from the main sequence (average over namespaces, by size) and the share of hub-like types.
        var weight = namespaces.Sum(n => n.Metric("types"));
        var distance = weight == 0 ? 0 : namespaces.Sum(n => n.Metric("distance") * n.Metric("types")) / weight;
        var hubs = types.Count == 0 ? 0 : (double)types.Count(t => t.Metric("ca") >= options.HubMinCa && t.Metric("ce") >= options.HubMinCe || t.Metric("ce") >= 20) / types.Count;
        var coupling = Clamp(0.5 * distance + 0.5 * Math.Min(1, 10 * hubs));

        // Findings: errors, warnings and infos per type (cycles and dead code are counted elsewhere or not at all).
        // Checks inside function bodies are not structure: with or without --checks the score is the same.
        var counted = findings.Where(f => !f.Rule.StartsWith("cycle.", StringComparison.Ordinal) && f.Rule is not ("tangle" or "dead-code") && f.Category != FindingCategory.Code).ToList();
        int Of(string severity) => counted.Count(f => f.Severity == severity);
        var (errors, warnings, infos) = (Of(FindingSeverity.Error), Of(FindingSeverity.Warning), Of(FindingSeverity.Info));
        var density = (5.0 * errors + 2.0 * warnings + 0.5 * infos) / Math.Max(10, types.Count);
        var findingsValue = Clamp(2 * density);

        // Size: lines in large types, and methods that are too complex.
        var typeLoc = types.Sum(t => t.Metric("loc"));
        var largeLoc = types.Where(t => t.Metric("loc") >= options.LargeTypeLoc).Sum(t => t.Metric("loc"));
        var largeShare = typeLoc == 0 ? 0 : largeLoc / typeLoc;
        var methods = graph.Nodes.Where(n => n.Kind is NodeKinds.Method or NodeKinds.Function && Counted(n)).ToList();
        var complexShare = methods.Count == 0 ? 0 : (double)methods.Count(m => m.Metric("complexity") >= options.ComplexMethod) / methods.Count;
        var size = Clamp(0.5 * Math.Min(1, 2 * largeShare) + 0.5 * Math.Min(1, 5 * complexShare));

        HealthComponent Part(string name, double weight, double value, string explanation) =>
            new() { Name = name, Weight = weight, Value = Math.Round(value, 3), Penalty = Math.Round(weight * value, 1), Explanation = explanation };

        var components = new List<HealthComponent>
        {
            Part("cycles", 25, cycles, $"{P(nsShare)} of namespaces, {P(typeShare)} of types and {P(projectShare)} of projects are in cycles."),
            Part("layers", 20, layers, $"{P(upShare)} of the dependency weight between {layerLevel}s points up ({upward} of {total} references)."),
            Part("coupling", 20, coupling, $"Average distance from the main sequence {N(distance)}; {P(hubs)} of types are hubs or use 20+ types."),
            Part("findings", 20, findingsValue, $"{errors} errors, {warnings} warnings and {infos} infos (other than cycles and dead code) for {types.Count} types."),
            Part("size", 15, size, $"{P(largeShare)} of the code is in types of {options.LargeTypeLoc}+ lines; {P(complexShare)} of methods have complexity {options.ComplexMethod}+."),
        };

        var score = (int)Math.Round(Math.Clamp(100 - components.Sum(c => c.Weight * c.Value), 0, 100));
        var grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "E";
        var worst = components.Where(c => c.Penalty >= 1).OrderByDescending(c => c.Penalty).Take(2).Select(c => $"{c.Name} (−{N(c.Penalty)})").ToList();
        var summary = $"{score}/100 ({grade})" + (worst.Count > 0 ? $": most is lost to {string.Join(" and ", worst)}." : ": no major structural problems.");
        return new HealthScore { Score = score, Grade = grade, Components = components, Summary = summary };
    }

    private static double Share(List<GraphNode> all, HashSet<string> marked) => all.Count == 0 ? 0 : (double)all.Count(n => marked.Contains(n.Id)) / all.Count;

    private static double Clamp(double value) => Math.Clamp(value, 0, 1);
}
