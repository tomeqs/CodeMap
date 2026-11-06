using System.Collections.Concurrent;
using System.Globalization;
using CodeMap.Loading;
using CodeMap.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMap.Languages.CSharp;

/// <summary>
/// Checks inside C# function bodies: a short list of compiler warnings that point at real bugs and hold up without
/// a build (no restored packages), and CodeMap's own rules for what the compiler does not warn about: swallowed or
/// re-thrown exceptions, async void, sync over async, locks on this, float equality, undisposed objects, properties that
/// call themselves, throws in finally. A semantic rule never fires on a type the compiler could not resolve.
/// </summary>
internal static class CSharpCodeChecks
{
    private sealed record Compiler(string Severity, string Category);

    /// <summary>The compiler warnings kept, and how they count.</summary>
    private static readonly Dictionary<string, Compiler> Allowed = new(StringComparer.Ordinal)
    {
        ["CS0162"] = new("warning", "dead-code"),      // unreachable code
        ["CS4014"] = new("warning", "async"),          // a task is not awaited
        ["CS0168"] = new("info", "dead-code"),         // variable declared, never used
        ["CS0219"] = new("info", "dead-code"),         // variable assigned, never used
        ["CS1717"] = new("warning", "correctness"),    // assignment to the same variable
        ["CS1718"] = new("warning", "correctness"),    // comparison to the same variable
        ["CS0665"] = new("warning", "correctness"),    // assignment in a condition
        ["CS0642"] = new("warning", "correctness"),    // possible mistaken empty statement
        ["CS0252"] = new("warning", "correctness"),    // reference comparison (left)
        ["CS0253"] = new("warning", "correctness"),    // reference comparison (right)
        ["CS0659"] = new("warning", "correctness"),    // Equals without GetHashCode
        ["CS0661"] = new("warning", "correctness"),    // == without GetHashCode
        ["CS0108"] = new("info", "correctness"),       // member hides an inherited one
        ["CS0114"] = new("info", "correctness"),       // member hides an inherited virtual one
        ["CS8600"] = new("warning", "nullability"),
        ["CS8602"] = new("warning", "nullability"),
        ["CS8603"] = new("warning", "nullability"),
        ["CS8604"] = new("warning", "nullability"),
    };

    /// <summary>Warnings that depend on knowing the types: dropped in members where the compiler could not resolve something.</summary>
    private static readonly HashSet<string> TypeSensitive = new(StringComparer.Ordinal) { "CS4014", "CS0252", "CS0253", "CS8600", "CS8602", "CS8603", "CS8604" };

    /// <summary>Disposables that own nothing to release: not worth a warning.</summary>
    private static readonly HashSet<string> HarmlessDisposables = new(StringComparer.Ordinal)
    {
        "System.IO.MemoryStream", "System.IO.StringReader", "System.IO.StringWriter", "System.Data.DataTable", "System.Data.DataSet",
        "System.Threading.Tasks.Task", "System.Threading.Tasks.Task`1",
    };

    public static void Run(SemanticModel model, string relativePath, ProjectInfo project, ConcurrentBag<CodeDiagnostic> sink, CancellationToken ct)
    {
        var tree = model.SyntaxTree;
        var root = tree.GetRoot(ct);
        CodeDiagnostic Diagnostic(string rule, string source, string severity, string category, string message, Location location)
        {
            var span = location.GetLineSpan();
            return new CodeDiagnostic
            {
                Rule = rule,
                Source = source,
                Severity = severity,
                Category = category,
                Message = message,
                Location = new SourceLocation { File = relativePath, Line = span.StartLinePosition.Line + 1, EndLine = span.EndLinePosition.Line + 1 },
                Column = span.StartLinePosition.Character + 1,
            };
        }

        // ------------------------------------------------------------------ compiler warnings
        var nullable = project.Nullable is "enable" or "warnings";
        var diagnostics = model.GetDiagnostics(cancellationToken: ct);
        var errors = diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.Location.SourceSpan).ToList();
        foreach (var d in diagnostics)
        {
            if (d.IsSuppressed || d.Severity != DiagnosticSeverity.Warning || !Allowed.TryGetValue(d.Id, out var info) || project.NoWarn.Contains(d.Id)) continue;
            if (d.Id.StartsWith("CS86", StringComparison.Ordinal) && !nullable) continue;
            if (TypeSensitive.Contains(d.Id) && MemberSpan(root, d.Location.SourceSpan) is { } member && errors.Any(e => member.Contains(e))) continue;
            sink.Add(Diagnostic(d.Id, "compiler", info.Severity, info.Category, d.GetMessage(CultureInfo.InvariantCulture), d.Location));
        }

        // ------------------------------------------------------------------ CodeMap's rules
        var walker = new Walker(model, (rule, severity, category, message, node) =>
            sink.Add(Diagnostic(rule, "codemap", severity, category, message, node.GetLocation())), ct);
        walker.Visit(root);
    }

    /// <summary>The span of the member (method, property, constructor…) a span is in.</summary>
    private static Microsoft.CodeAnalysis.Text.TextSpan? MemberSpan(SyntaxNode root, Microsoft.CodeAnalysis.Text.TextSpan span)
    {
        var node = root.FindNode(span, getInnermostNodeForTie: true);
        return node.AncestorsAndSelf().FirstOrDefault(n => n is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax or LocalFunctionStatementSyntax or GlobalStatementSyntax)?.Span;
    }

    private delegate void Report(string rule, string severity, string category, string message, SyntaxNode at);

    private sealed class Walker(SemanticModel model, Report report, CancellationToken ct) : CSharpSyntaxWalker
    {
        private bool Resolved(ITypeSymbol? type) => type != null && type is not IErrorTypeSymbol && type.TypeKind != TypeKind.Error;

        public override void Visit(SyntaxNode? node)
        {
            ct.ThrowIfCancellationRequested();
            base.Visit(node);
        }

        // -------------------------------------------------------------- exceptions

        public override void VisitCatchClause(CatchClauseSyntax node)
        {
            var block = node.Block;
            var variable = node.Declaration?.Identifier.ValueText;
            var catchesAll = node.Declaration == null || IsException(model.GetTypeInfo(node.Declaration.Type, ct).Type);
            if (block.Statements.Count == 0)
            {
                // A comment inside says it is on purpose.
                if (!block.DescendantTrivia().Any(t => t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia)) && node.Filter == null)
                {
                    report("empty-catch", "warning", "exceptions",
                        $"Empty catch block: {(catchesAll ? "every exception" : $"{node.Declaration!.Type}")} is silently ignored. Handle it, log it, or say in a comment why ignoring it is safe.",
                        node.CatchKeyword.Parent!);
                }
            }
            else if (catchesAll && node.Filter == null)
            {
                var throws = block.DescendantNodes().Any(n => n is ThrowStatementSyntax or ThrowExpressionSyntax);
                var usesException = variable != null && block.DescendantNodes().OfType<IdentifierNameSyntax>().Any(i => i.Identifier.ValueText == variable);
                var logs = block.DescendantNodes().OfType<InvocationExpressionSyntax>().Any(i => LooksLikeLogging(i.Expression.ToString()));
                if (!throws && !usesException && !logs)
                {
                    report("swallowed-exception", "info", "exceptions",
                        "Every exception is caught and dropped: nothing logs it, rethrows it or looks at it, so failures disappear without a trace.",
                        node.CatchKeyword.Parent!);
                }
            }

            if (variable != null)
            {
                foreach (var rethrow in block.DescendantNodes().OfType<ThrowStatementSyntax>())
                {
                    if (rethrow.Expression is IdentifierNameSyntax id && id.Identifier.ValueText == variable && !InsideLambda(rethrow, block))
                    {
                        report("rethrow-loses-stack", "warning", "exceptions",
                            $"'throw {variable};' starts a new stack trace and hides where the exception came from: use 'throw;'.", rethrow);
                    }
                }
            }

            base.VisitCatchClause(node);
        }

        public override void VisitFinallyClause(FinallyClauseSyntax node)
        {
            foreach (var thrown in node.Block.DescendantNodes().OfType<ThrowStatementSyntax>().Where(t => !InsideLambda(t, node.Block) && !InsideCatch(t, node.Block)))
            {
                report("throw-in-finally", "warning", "exceptions",
                    "A throw in finally replaces the exception that may be on its way out of the try block: that one is lost.", thrown);
            }

            base.VisitFinallyClause(node);
        }

        // -------------------------------------------------------------- async

        public override void VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            CheckAsyncVoid(node.Modifiers, node.ReturnType, node.ParameterList, node.Identifier.ValueText, node);
            base.VisitMethodDeclaration(node);
        }

        public override void VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
        {
            CheckAsyncVoid(node.Modifiers, node.ReturnType, node.ParameterList, node.Identifier.ValueText, node);
            base.VisitLocalFunctionStatement(node);
        }

        private void CheckAsyncVoid(SyntaxTokenList modifiers, TypeSyntax returnType, ParameterListSyntax parameters, string name, SyntaxNode at)
        {
            if (!modifiers.Any(SyntaxKind.AsyncKeyword) || returnType is not PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.VoidKeyword }) return;
            // Event handlers have to return void: (object sender, SomethingEventArgs e).
            var list = parameters.Parameters;
            if (list.Count == 2 && (list[1].Type?.ToString().EndsWith("EventArgs", StringComparison.Ordinal) == true || IsEventArgs(list[1].Type))) return;
            report("async-void", "warning", "async",
                $"'async void {name}': nobody can await it, and an exception in it crashes the process. Return Task.", at is MethodDeclarationSyntax m ? m.Identifier.Parent! : at);
        }

        private bool IsEventArgs(TypeSyntax? syntax)
        {
            for (var type = syntax != null ? model.GetTypeInfo(syntax, ct).Type : null; type != null; type = type.BaseType)
            {
                if (type.ToDisplayString() == "System.EventArgs") return true;
            }

            return false;
        }

        public override void VisitMemberAccessExpression(MemberAccessExpressionSyntax node)
        {
            if (node.Name.Identifier.ValueText == "Result" && !InMain(node) && model.GetSymbolInfo(node, ct).Symbol is IPropertySymbol { ContainingType: { } owner } && IsTaskType(owner))
            {
                report("sync-over-async", "warning", "async",
                    "'.Result' blocks the thread until the task finishes: a deadlock under a synchronization context, and a waste of a thread pool thread. Await it.", node.Name);
            }

            base.VisitMemberAccessExpression(node);
        }

        public override void VisitInvocationExpression(InvocationExpressionSyntax node)
        {
            if (node.Expression is MemberAccessExpressionSyntax access && !InMain(node))
            {
                var name = access.Name.Identifier.ValueText;
                if (name is "Wait" or "GetResult" && model.GetSymbolInfo(node, ct).Symbol is IMethodSymbol method)
                {
                    var blocks = name == "Wait" ? method.ContainingType is { } t && IsTaskType(t) && method.Parameters.Length == 0
                        : method.ContainingType?.Name is "TaskAwaiter" or "ValueTaskAwaiter" && access.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "GetAwaiter" } };
                    if (blocks)
                    {
                        report("sync-over-async", "warning", "async",
                            $"'{(name == "Wait" ? ".Wait()" : ".GetAwaiter().GetResult()")}' blocks the thread until the task finishes: a deadlock under a synchronization context. Await it.", access.Name);
                    }
                }
            }

            base.VisitInvocationExpression(node);
        }

        private static bool InMain(SyntaxNode node) =>
            node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault() is { Identifier.ValueText: "Main" } || node.Ancestors().OfType<GlobalStatementSyntax>().Any();

        private static bool IsTaskType(INamedTypeSymbol type) =>
            type.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks" && type.Name is "Task" or "ValueTask";

        // -------------------------------------------------------------- concurrency, equality

        public override void VisitLockStatement(LockStatementSyntax node)
        {
            var what = node.Expression switch
            {
                ThisExpressionSyntax => "this",
                TypeOfExpressionSyntax => "a Type object",
                LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } => "a string literal",
                _ => null,
            };
            if (what != null)
            {
                report("lock-on-this", "warning", "concurrency",
                    $"lock on {what}: code outside the class can take the same lock and deadlock with it. Lock on a private readonly object.", node.Expression);
            }

            base.VisitLockStatement(node);
        }

        public override void VisitBinaryExpression(BinaryExpressionSyntax node)
        {
            if (node.IsKind(SyntaxKind.EqualsExpression) || node.IsKind(SyntaxKind.NotEqualsExpression))
            {
                var left = model.GetTypeInfo(node.Left, ct).Type;
                var right = model.GetTypeInfo(node.Right, ct).Type;
                if (IsFloat(left) && IsFloat(right) && !IsWholeConstant(node.Left) && !IsWholeConstant(node.Right))
                {
                    report("float-equality", "info", "correctness",
                        $"'{node}' compares floating-point numbers exactly: rounding makes equal values differ. Compare with a tolerance (Math.Abs(a - b) < epsilon).", node);
                }
            }

            base.VisitBinaryExpression(node);
        }

        private static bool IsFloat(ITypeSymbol? type) => type?.SpecialType is SpecialType.System_Single or SpecialType.System_Double;

        /// <summary>A constant like 0 or 1 (and NaN / infinity checks): comparing with it exactly is usually meant.</summary>
        private bool IsWholeConstant(ExpressionSyntax expression)
        {
            var value = model.GetConstantValue(expression, ct);
            if (!value.HasValue) return false;
            var number = Convert.ToDouble(value.Value, CultureInfo.InvariantCulture);
            return double.IsNaN(number) || double.IsInfinity(number) || Math.Abs(number % 1) < double.Epsilon;
        }

        // -------------------------------------------------------------- properties

        public override void VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            var name = node.Identifier.ValueText;
            bool IsSelf(ExpressionSyntax? e) =>
                e is IdentifierNameSyntax id && id.Identifier.ValueText == name
                || e is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: var n } && n.Identifier.ValueText == name;

            void Recursive(SyntaxNode at, string what) => report("recursive-property", "error", "correctness",
                $"The {what} of {name} uses {name} itself: it calls itself until the stack overflows. Use a backing field.", at);

            if (IsSelf(node.ExpressionBody?.Expression)) Recursive(node.ExpressionBody!, "getter");
            foreach (var accessor in node.AccessorList?.Accessors ?? default)
            {
                var getter = accessor.IsKind(SyntaxKind.GetAccessorDeclaration);
                var setter = accessor.IsKind(SyntaxKind.SetAccessorDeclaration) || accessor.IsKind(SyntaxKind.InitAccessorDeclaration);
                if (getter && (IsSelf(accessor.ExpressionBody?.Expression) || accessor.Body?.Statements is [ReturnStatementSyntax { Expression: var returned }] && IsSelf(returned)))
                    Recursive(accessor, "getter");
                if (setter && (accessor.ExpressionBody?.Expression is AssignmentExpressionSyntax { Left: var target } && IsSelf(target)
                               || accessor.Body?.Statements is [ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Left: var assigned } }] && IsSelf(assigned)))
                    Recursive(accessor, "setter");
            }

            base.VisitPropertyDeclaration(node);
        }

        // -------------------------------------------------------------- resources

        public override void VisitLocalDeclarationStatement(LocalDeclarationStatementSyntax node)
        {
            if (node.UsingKeyword.IsKind(SyntaxKind.None) && node.Parent is BlockSyntax block)
            {
                foreach (var variable in node.Declaration.Variables)
                {
                    if (variable.Initializer?.Value is not BaseObjectCreationExpressionSyntax creation) continue;
                    if (model.GetTypeInfo(creation, ct).Type is not INamedTypeSymbol type || !Resolved(type) || !IsDisposable(type)) continue;
                    if (HarmlessDisposables.Contains(MetadataName(type.OriginalDefinition))) continue;
                    if (model.GetDeclaredSymbol(variable, ct) is not ILocalSymbol local) continue;
                    if (OnlyUsedAsReceiver(block, local))
                    {
                        report("disposable-not-disposed", "warning", "resources",
                            $"'{local.Name}' is a {type.Name}, which holds resources, but it is never disposed. Declare it with 'using'.", variable);
                    }
                }
            }

            base.VisitLocalDeclarationStatement(node);
        }

        private static string MetadataName(INamedTypeSymbol type) =>
            $"{type.ContainingNamespace?.ToDisplayString()}.{type.MetadataName}";

        private static bool IsDisposable(INamedTypeSymbol type) =>
            type.AllInterfaces.Any(i => i.ToDisplayString() is "System.IDisposable" or "System.IAsyncDisposable");

        /// <summary>
        /// The variable is only ever used to call members on (never disposed, closed, returned, passed, stored or captured):
        /// nothing else can be responsible for disposing it.
        /// </summary>
        private bool OnlyUsedAsReceiver(BlockSyntax block, ILocalSymbol local)
        {
            foreach (var id in block.DescendantNodes().OfType<IdentifierNameSyntax>())
            {
                if (id.Identifier.ValueText != local.Name || !SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(id, ct).Symbol, local)) continue;
                if (id.Ancestors().Any(a => a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)) return false;
                switch (id.Parent)
                {
                    case MemberAccessExpressionSyntax access when access.Expression == id:
                        if (access.Name.Identifier.ValueText is "Dispose" or "DisposeAsync" or "Close") return false;
                        continue;
                    case ConditionalAccessExpressionSyntax conditional when conditional.Expression == id:
                        if (conditional.WhenNotNull.ToString().Contains("Dispose", StringComparison.Ordinal) || conditional.WhenNotNull.ToString().Contains("Close", StringComparison.Ordinal)) return false;
                        continue;
                    default:
                        return false; // returned, passed, assigned, used in a using statement...: someone else may own it
                }
            }

            return true;
        }

        // -------------------------------------------------------------- helpers

        private static bool IsException(ITypeSymbol? type) => type?.ToDisplayString() is "System.Exception";

        private static bool LooksLikeLogging(string call)
        {
            var text = call.ToLowerInvariant();
            return text.Contains("log") || text.Contains("trace") || text.Contains("write") || text.Contains("report") || text.Contains("telemetry")
                   || text.Contains("capture") || text.Contains("notify") || text.Contains("error") || text.Contains("warn");
        }

        private static bool InsideLambda(SyntaxNode node, SyntaxNode stop) =>
            node.Ancestors().TakeWhile(a => a != stop).Any(a => a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax);

        private static bool InsideCatch(SyntaxNode node, SyntaxNode stop) =>
            node.Ancestors().TakeWhile(a => a != stop).Any(a => a is CatchClauseSyntax or TryStatementSyntax);
    }
}
