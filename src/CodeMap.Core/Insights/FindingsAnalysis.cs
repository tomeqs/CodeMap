using System.Globalization;
using CodeMap.Model;

namespace CodeMap.Insights;

/// <summary>
/// Reads a finished map for spaghetti code, structural problems, DI mistakes and dead code (<see cref="FindingRules"/>):
/// each finding comes with the nodes, the places in the code and the numbers behind it, and what usually fixes it.
/// Computed on demand from the graph; nothing is stored in the map. Test and generated code are left out unless
/// <see cref="FindingOptions"/> says otherwise.
/// </summary>
public static partial class FindingsAnalysis
{
    public static FindingsReport Compute(CodeGraph graph, FindingOptions? options = null, GraphIndex? index = null)
    {
        var context = new Context(graph, index ?? new GraphIndex(graph), options ?? new FindingOptions());

        Cycles(context);
        Hubs(context);
        GodClassesAndEnvy(context);
        Sizes(context);
        Inheritance(context);
        MiddleMen(context);
        UnimplementedInterfaces(context);
        LayerConventions(context);
        MainSequence(context);
        TinyModules(context);
        TestDependencies(context);
        History(context);
        DependencyInjection(context);
        DeadCode(context);

        var findings = context.Findings
            .GroupBy(f => f.Id, StringComparer.Ordinal).Select(g => g.First())
            .OrderByDescending(f => f.Rank)
            .ThenBy(f => f.Id, StringComparer.Ordinal)
            .ToList();
        return new FindingsReport
        {
            Findings = findings,
            Score = HealthScore.Compute(context.Index, context.Options, findings),
            BySeverity = Count(findings, f => f.Severity),
            ByCategory = Count(findings, f => f.Category),
            ByRule = Count(findings, f => f.Rule),
        };
    }

    private static Dictionary<string, int> Count(List<Finding> findings, Func<Finding, string> key) =>
        findings.GroupBy(key, StringComparer.Ordinal).OrderBy(g => g.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

    /// <summary>The graph, its index and options, and the findings collected so far.</summary>
    private sealed class Context
    {
        public Context(CodeGraph graph, GraphIndex index, FindingOptions options)
        {
            Graph = graph;
            Index = index;
            Options = options;
            Classes = new ClassMetrics(index);
        }

        public CodeGraph Graph { get; }
        public GraphIndex Index { get; }
        public FindingOptions Options { get; }
        public ClassMetrics Classes { get; }
        public List<Finding> Findings { get; } = new();

        /// <summary>Left out: external code, and test or generated code (EF migrations too) unless asked for.</summary>
        public bool Skip(GraphNode node) =>
            node.External
            || !Options.IncludeTests && Index.IsTest(node)
            || !Options.IncludeGenerated && (Index.IsGenerated(node) || Index.AncestorsAndSelf(node).Any(n => n.BaseType is "Migration" or "ModelSnapshot"));

        public bool Skip(string id) => Index.Node(id) is not { } node || Skip(node);

        /// <summary>Internal type-level nodes that are not left out.</summary>
        public IEnumerable<GraphNode> Types => Graph.Nodes.Where(n => NodeLevels.IsType(n) && !Skip(n));

        /// <summary>Full name for messages (a project by its name: a package's full name is its manifest's path).</summary>
        public string Name(string id) =>
            Index.Node(id) is not { } node ? id : NodeLevels.Of(node) == NodeLevels.Project ? node.Name : node.FullName ?? node.Name;

        /// <summary>Short name for lists: a member with its class, a class inside a file by itself, "(root)" folders in full.</summary>
        public string Short(string id)
        {
            if (Index.Node(id) is not { } node) return id;
            if (node.Name.StartsWith('(')) return node.FullName ?? node.Name;
            if (!NodeLevels.IsMember(node) || ClassMetrics.IsClass(node) || Index.ParentOf(node) is not { } parent) return node.Name;
            return NodeLevels.IsType(parent) || ClassMetrics.IsClass(parent) ? $"{parent.Name}.{node.Name}" : node.Name;
        }

        public FindingLocation? At(string id, string? note = null)
        {
            var node = Index.Node(id);
            return node?.Location is { } location
                ? new FindingLocation { File = location.File, Line = location.Line, EndLine = location.EndLine, Node = id, Note = note }
                : null;
        }

        /// <summary>The places of the edges behind a dependency, heaviest first, one per line.</summary>
        public IEnumerable<FindingLocation> At(Dependency dependency, int max)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var edge in dependency.Edges)
            {
                if (Index.Where(edge) is not { } where || !seen.Add(where.ToString())) continue;
                yield return new FindingLocation { File = where.File, Line = where.Line, Node = edge.Source, Note = $"{edge.Kind} {Short(edge.Target)}" };
                if (seen.Count >= max) yield break;
            }
        }

        /// <summary>"A → B: 3 references (calls ×2, uses ×1), e.g. src/a.cs:12".</summary>
        public string Describe(Dependency dependency)
        {
            var kinds = string.Join(", ", dependency.Kinds.OrderByDescending(k => k.Value).ThenBy(k => k.Key, StringComparer.Ordinal).Select(k => $"{k.Key} ×{k.Value}"));
            var first = At(dependency, 1).FirstOrDefault();
            return $"{Short(dependency.Source)} → {Short(dependency.Target)}: {Plural(dependency.Weight, "reference")} ({kinds}){(first != null ? $", e.g. {first}" : "")}";
        }

        public void Add(string rule, string key, string severity, string title, string message, double impact,
            IEnumerable<string> nodes, IEnumerable<FindingLocation?> locations, Dictionary<string, double>? evidence = null,
            List<string>? facts = null, string? suggestion = null, string[]? proposalKinds = null, string? category = null)
        {
            var info = FindingRules.Find(rule) ?? FindingRules.Find(rule.Split('.')[0]);
            Findings.Add(new Finding
            {
                Id = $"{rule}@{key}",
                Rule = rule,
                Category = category ?? info?.Category ?? FindingCategory.Structure,
                Severity = severity,
                Title = title,
                Message = message,
                Nodes = nodes.Distinct(StringComparer.Ordinal).ToList(),
                Locations = locations.Where(l => l != null).Select(l => l!).DistinctBy(l => (l.File, l.Line)).Take(Options.MaxLocations).ToList(),
                Evidence = evidence ?? new Dictionary<string, double>(StringComparer.Ordinal),
                Facts = facts is { Count: > 0 } ? facts : null,
                Suggestion = suggestion,
                ProposalKinds = (proposalKinds ?? info?.ProposalKinds ?? Array.Empty<string>()).ToList(),
                Rank = Rank(severity, impact),
            });
        }
    }

    /// <summary>Errors before warnings before infos; within a severity, the bigger problem first.</summary>
    private static double Rank(string severity, double impact) =>
        (3 - FindingSeverity.Order(severity)) * 1000 + Math.Round(Math.Clamp(impact, 0, 999), 2);

    private static string Plural(double count, string word, string? plural = null) =>
        $"{count.ToString("0.##", CultureInfo.InvariantCulture)} {(count == 1 ? word : plural ?? word + "s")}";

    private static string F(double value) => value.ToString(value % 1 == 0 ? "0" : "0.###", CultureInfo.InvariantCulture);

    private static string List(IEnumerable<string> names, int max = 6)
    {
        var all = names.ToList();
        return string.Join(", ", all.Take(max)) + (all.Count > max ? $" and {all.Count - max} more" : "");
    }

    private static Dictionary<string, double> Evidence(params (string Key, double Value)[] values)
    {
        var result = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var (key, value) in values) result[key] = Math.Round(value, 3);
        return result;
    }

    /// <summary>The value at a percentile of a list (nearest rank).</summary>
    private static double Percentile(List<double> values, double p)
    {
        if (values.Count == 0) return 0;
        values.Sort();
        var rank = (int)Math.Ceiling(p * values.Count) - 1;
        return values[Math.Clamp(rank, 0, values.Count - 1)];
    }
}
