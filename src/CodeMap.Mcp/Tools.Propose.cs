using System.Text.Json;
using CodeMap.Insights;

namespace CodeMap.Mcp;

internal static partial class Tools
{
    private static readonly ToolDef ProposeRefactorings = new("propose_refactorings", "Propose refactorings",
        "Concrete refactorings for the findings, worst problems first: break cycles (invert or move the cheapest cut), invert layer " +
        "violations, move envious methods, split god classes along their groups of members, merge tiny namespaces, delete dead " +
        "code, fix DI lifetimes. Each comes with steps in the code (file:line), its cost, the simulator operations, and, verified " +
        "by a simulation, which findings it really resolves and how the score changes. Candidates that would add a cycle are dropped.",
        """
        {"type":"object","properties":{
          "finding":{"type":"string","description":"Only for this finding (an id from list_findings)."},
          "within":{"type":"string","description":"Only for findings about this project, namespace or type (id or name)."},
          "kinds":{"type":"array","items":{"type":"string","enum":["break-cycle","invert-dependency","move-type","move-member","split-type","merge-namespaces","remove-dead-code","fix-di"]}},
          "limit":{"type":"number","description":"How many proposals (default 5, at most 20)."},
          "verify":{"type":"boolean","description":"Simulate each proposal to show what it fixes (default true; false is faster)."},
          "graph":{"type":"string","description":"current (default), a baseline, or a simulation."}
        }}
        """,
        async (call, ct) =>
        {
            var s = await call.Session.GraphAsync(call.String("graph"), ct).ConfigureAwait(false);
            var request = new ProposalRequest
            {
                Finding = call.String("finding"),
                Scope = call.String("within") is { } within ? call.Node(s, within).Id : null,
                Kinds = call.List("kinds") is { Count: > 0 } kinds ? kinds : null,
                Limit = call.Int("limit", 5, 1, 20),
                Verify = call.Bool("verify", true),
            };

            List<Proposal> proposals;
            try
            {
                proposals = await Task.Run(() => ProposalEngine.Propose(s.Raw, s.Graph, s.Findings, s.Index, request, ct), ct).ConfigureAwait(false);
            }
            catch (ArgumentException ex)
            {
                throw new ToolException(ex.Message);
            }

            return new
            {
                total = proposals.Count,
                proposals = proposals.Select(p => new
                {
                    id = p.Id,
                    kind = p.Kind,
                    title = p.Title,
                    rationale = p.Rationale,
                    confidence = Math.Round(p.Confidence, 2),
                    targets = p.Targets,
                    cost = p.Cost,
                    steps = p.Steps,
                    operations = p.Ops.Select(op => JsonSerializer.SerializeToNode(op, op.GetType(), Answers.Json)).ToList(),
                    predicted = p.Predicted == null ? null : new
                    {
                        score = $"{p.Predicted.ScoreBefore} → {p.Predicted.ScoreAfter}",
                        resolves = p.Predicted.Resolved,
                        adds = p.Predicted.Added.Count > 0 ? p.Predicted.Added : null,
                        summary = p.Predicted.Summary,
                    },
                }).ToList(),
                next = proposals.Count == 0
                    ? "No refactoring found that helps without adding a cycle; list_findings and explain_dependency show the details to decide by hand."
                    : "simulate with a proposal's operations to explore it (graph: \"sim-N\" in every tool), then change the code and compare.",
            };
        });
}
