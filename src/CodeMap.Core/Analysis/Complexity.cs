using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeMap.Analysis;

internal static class Complexity
{
    /// <summary>Number of decision points (cyclomatic complexity minus one) inside <paramref name="node"/>.</summary>
    public static int DecisionPoints(SyntaxNode? node)
    {
        if (node == null) return 0;
        var count = 0;
        foreach (var n in node.DescendantNodesAndSelf())
        {
            switch (n.Kind())
            {
                case SyntaxKind.IfStatement:
                case SyntaxKind.ConditionalExpression:
                case SyntaxKind.CaseSwitchLabel:
                case SyntaxKind.CasePatternSwitchLabel:
                case SyntaxKind.SwitchExpressionArm:
                case SyntaxKind.ForStatement:
                case SyntaxKind.ForEachStatement:
                case SyntaxKind.ForEachVariableStatement:
                case SyntaxKind.WhileStatement:
                case SyntaxKind.DoStatement:
                case SyntaxKind.CatchClause:
                case SyntaxKind.LogicalAndExpression:
                case SyntaxKind.LogicalOrExpression:
                case SyntaxKind.CoalesceExpression:
                case SyntaxKind.CoalesceAssignmentExpression:
                case SyntaxKind.ConditionalAccessExpression:
                case SyntaxKind.AndPattern:
                case SyntaxKind.OrPattern:
                    count++;
                    break;
            }
        }

        return count;
    }
}
