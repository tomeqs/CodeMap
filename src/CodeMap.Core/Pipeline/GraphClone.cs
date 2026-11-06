using CodeMap.Model;

namespace CodeMap.Pipeline;

/// <summary>Deep copies of graphs: nothing mutable is shared (strings are), so a copy can be changed and derived freely.</summary>
public static class GraphClone
{
    public static CodeGraph Clone(this CodeGraph graph) => new()
    {
        Format = graph.Format,
        Version = graph.Version,
        Generator = new GeneratorInfo { Name = graph.Generator.Name, Version = graph.Generator.Version },
        GeneratedAt = graph.GeneratedAt,
        Source = Clone(graph.Source),
        Stats = new Dictionary<string, int>(graph.Stats),
        Nodes = graph.Nodes.Select(Clone).ToList(),
        Edges = graph.Edges.Select(Clone).ToList(),
        Analysis = Clone(graph.Analysis),
    };

    public static GraphNode Clone(GraphNode node) => new()
    {
        Id = node.Id,
        Kind = node.Kind,
        Level = node.Level,
        Name = node.Name,
        FullName = node.FullName,
        Parent = node.Parent,
        Project = node.Project,
        Language = node.Language,
        Namespace = node.Namespace,
        Accessibility = node.Accessibility,
        Modifiers = node.Modifiers?.ToList(),
        Signature = node.Signature,
        BaseType = node.BaseType,
        Location = Clone(node.Location),
        ExtraLocations = node.ExtraLocations?.Select(l => Clone(l)!).ToList(),
        Attributes = node.Attributes?.ToList(),
        Tags = node.Tags?.ToList(),
        Doc = node.Doc,
        External = node.External,
        Metrics = node.Metrics == null ? null : new Dictionary<string, double>(node.Metrics),
    };

    public static GraphEdge Clone(GraphEdge edge) => new() { Source = edge.Source, Target = edge.Target, Kind = edge.Kind, Weight = edge.Weight, Line = edge.Line };

    private static SourceLocation? Clone(SourceLocation? location) =>
        location == null ? null : new SourceLocation { File = location.File, Line = location.Line, EndLine = location.EndLine };

    private static SourceInfo Clone(SourceInfo source) => new()
    {
        Path = source.Path,
        Root = source.Root,
        Kind = source.Kind,
        Name = source.Name,
        Languages = source.Languages?.Select(l => new LanguageSummary
        {
            Id = l.Id,
            Name = l.Name,
            External = l.External,
            Levels = new LevelLabels
            {
                Project = l.Levels.Project.ToList(),
                Namespace = l.Levels.Namespace.ToList(),
                Type = l.Levels.Type.ToList(),
                Member = l.Levels.Member.ToList(),
            },
        }).ToList(),
        Git = source.Git == null ? null : new GitInfo
        {
            Branch = source.Git.Branch,
            Commit = source.Git.Commit,
            CommitsAnalyzed = source.Git.CommitsAnalyzed,
            Since = source.Git.Since,
            Shallow = source.Git.Shallow,
        },
    };

    private static AnalysisResult Clone(AnalysisResult analysis) => new()
    {
        Cycles = analysis.Cycles.Select(c => new CycleInfo { Level = c.Level, Nodes = c.Nodes.ToList() }).ToList(),
        Hotspots = analysis.Hotspots.Select(Clone).ToList(),
        MostComplex = analysis.MostComplex.Select(Clone).ToList(),
        MostDepended = analysis.MostDepended.Select(Clone).ToList(),
        UnusedCandidates = analysis.UnusedCandidates.ToList(),
        Layers = analysis.Layers.Select(l => new LayeringInfo
        {
            Level = l.Level,
            Layers = l.Layers.Select(layer => layer.ToList()).ToList(),
            Upward = l.Upward.Select(Clone).ToList(),
        }).ToList(),
        ChangeCoupling = analysis.ChangeCoupling.Select(c => new ChangeCouplingInfo
        {
            Source = c.Source,
            Target = c.Target,
            SharedCommits = c.SharedCommits,
            Strength = c.Strength,
            Hidden = c.Hidden,
        }).ToList(),
        Di = analysis.Di == null ? null : Clone(analysis.Di),
        Warnings = analysis.Warnings.ToList(),
    };

    private static RankedItem Clone(RankedItem item) => new() { Id = item.Id, Score = item.Score };

    private static DiAnalysis Clone(DiAnalysis di) => new()
    {
        Registrations = di.Registrations.Select(r => new ServiceRegistration
        {
            Service = r.Service,
            External = r.External,
            TypeArguments = r.TypeArguments?.ToList(),
            Implementation = r.Implementation,
            Lifetime = r.Lifetime,
            Effective = r.Effective,
            Kind = r.Kind,
            Framework = r.Framework,
            Key = r.Key,
            RegisteredIn = r.RegisteredIn,
            Location = Clone(r.Location),
        }).ToList(),
        Dependencies = di.Dependencies.Select(d => new DiDependency
        {
            Consumer = d.Consumer,
            ConsumerLifetime = d.ConsumerLifetime,
            Service = d.Service,
            External = d.External,
            TypeArguments = d.TypeArguments?.ToList(),
            Many = d.Many,
            Optional = d.Optional,
            Key = d.Key,
            Implementations = d.Implementations.ToList(),
            Lifetime = d.Lifetime,
            Framework = d.Framework,
        }).ToList(),
        Issues = di.Issues.Select(i => new DiIssue { Kind = i.Kind, Severity = i.Severity, Consumer = i.Consumer, Service = i.Service, Message = i.Message }).ToList(),
    };
}
