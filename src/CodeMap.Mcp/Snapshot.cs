using CodeMap.Insights;
using CodeMap.Model;
using CodeMap.Pipeline;

namespace CodeMap.Mcp;

/// <summary>One analysis the session holds: the raw graph, the finished map, and what is computed from it on demand.</summary>
internal sealed class Snapshot
{
    private readonly Lazy<GraphIndex> _index;
    private readonly Lazy<FindingsReport> _findings;
    private readonly Lazy<CallFlow> _flow;

    public Snapshot(string name, string path, RawGraph raw, CodeGraph graph, string origin, double seconds)
    {
        Name = name;
        Path = path;
        Raw = raw;
        Graph = graph;
        Origin = origin;
        Seconds = seconds;
        _index = new Lazy<GraphIndex>(() => new GraphIndex(Graph));
        _findings = new Lazy<FindingsReport>(() => FindingsAnalysis.Compute(Graph, null, Index));
        _flow = new Lazy<CallFlow>(() => new CallFlow(Index));
    }

    /// <summary>The name of what was analyzed (solution, project, folder).</summary>
    public string Name { get; }

    /// <summary>What was analyzed (absolute).</summary>
    public string Path { get; }

    public RawGraph Raw { get; }

    public CodeGraph Graph { get; }

    /// <summary>analysis | file | simulation</summary>
    public string Origin { get; }

    public DateTimeOffset At { get; } = DateTimeOffset.UtcNow;

    /// <summary>How long the analysis took.</summary>
    public double Seconds { get; }

    public GraphIndex Index => _index.Value;

    public FindingsReport Findings => _findings.Value;

    public CallFlow Flow => _flow.Value;
}
