using CodeMap.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMap.Analysis;

/// <summary>
/// Walks a piece of syntax (signature, body, initializer...) and records every symbol it references
/// as an edge from the current source node. <see cref="Context"/> decides how plain type references
/// are classified (holds / returns / accepts / injects / uses).
/// </summary>
internal sealed class ReferenceWalker : CSharpSyntaxWalker
{
    private readonly GraphBuilder _builder;
    private readonly SemanticModel _model;
    private string? _source;
    private INamedTypeSymbol? _selfType;
    /// <summary>Inside nameof(...): names are only mentioned, nothing is called or read.</summary>
    private bool _inNameof;

    public ReferenceWalker(GraphBuilder builder, SemanticModel model) : base(SyntaxWalkerDepth.Node)
    {
        _builder = builder;
        _model = model;
    }

    public string Context { get; private set; } = EdgeKinds.Uses;

    /// <summary>File being walked, relative to the source root (for DI registration locations).</summary>
    public string RelativePath { get; init; } = "";

    public void Walk(SyntaxNode? node, string? sourceKey, INamedTypeSymbol? selfType, string context)
    {
        if (node == null || sourceKey == null) return;
        var (previousSource, previousSelf, previousContext) = (_source, _selfType, Context);
        (_source, _selfType, Context) = (sourceKey, selfType, context);
        try
        {
            Visit(node);
        }
        finally
        {
            (_source, _selfType, Context) = (previousSource, previousSelf, previousContext);
        }
    }

    public void Walk<T>(SyntaxList<T> nodes, string? sourceKey, INamedTypeSymbol? selfType, string context) where T : SyntaxNode
    {
        foreach (var node in nodes) Walk(node, sourceKey, selfType, context);
    }

    // ------------------------------------------------------------------ names

    public override void VisitIdentifierName(IdentifierNameSyntax node) => HandleName(node);

    public override void VisitGenericName(GenericNameSyntax node)
    {
        HandleName(node);
        // ICommandHandler<PlaceOrder, Result> injects the handler, it merely *uses* its type arguments.
        if (Context == EdgeKinds.Injects) WithContext(EdgeKinds.Uses, () => base.VisitGenericName(node));
        else base.VisitGenericName(node);
    }

    private void HandleName(SimpleNameSyntax node)
    {
        // Argument names (Foo(count: 3), tuple element names) name parameters, not members; the names of a
        // property pattern (`is { Status: ... }`) do read the property.
        if (node.IsVar || node.Parent is NameColonSyntax { Parent: ArgumentSyntax or AttributeArgumentSyntax }) return;
        var symbol = GetSymbol(node);
        if (_inNameof && symbol is not (INamedTypeSymbol or IAliasSymbol)) return;
        switch (symbol)
        {
            case null:
                return;
            case IAliasSymbol alias:
                if (alias.Target is ITypeSymbol aliasType && !IsSpecialTypePosition(node)) AddTypeEdge(aliasType, Context);
                return;
            case INamedTypeSymbol type:
                if (IsSpecialTypePosition(node)) return;
                AddTypeEdge(type, Context);
                return;
            case IMethodSymbol method:
                if (method.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction or MethodKind.Constructor
                    or MethodKind.StaticConstructor or MethodKind.LambdaMethod) return;
                AddMemberEdge(method, EdgeKinds.Calls, node);
                return;
            case IPropertySymbol property:
                AddMemberEdge(property, EdgeKinds.Accesses);
                return;
            case IFieldSymbol field:
                if (field.ContainingType?.TypeKind == TypeKind.Enum)
                {
                    AddTypeEdge(field.ContainingType, EdgeKinds.Uses);
                    return;
                }

                AddMemberEdge(field, EdgeKinds.Accesses);
                return;
            case IEventSymbol @event:
                AddMemberEdge(@event, IsSubscription(node) ? EdgeKinds.Subscribes : EdgeKinds.Accesses);
                return;
        }
    }

    // ------------------------------------------------------------------ special expressions

    public override void VisitInvocationExpression(InvocationExpressionSyntax node)
    {
        // nameof(GetById) mentions the method, it does not call it: only the types in it count, as plain uses.
        if (node.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" } && _model.GetSymbolInfo(node.Expression).Symbol == null)
        {
            var previous = _inNameof;
            _inNameof = true;
            try { WithContext(EdgeKinds.Uses, () => Visit(node.ArgumentList)); }
            finally { _inNameof = previous; }
            return;
        }

        if (DiRegistrationDetector.TryDetect(node, _model) is { } registration)
        {
            // The line of the method name, not of the start of the call: in a fluent chain spread over
            // several lines, every call starts where the chain starts.
            var name = DiRegistrationDetector.MethodName(node)!;
            _builder.AddRegistration(registration, _source, new SourceLocation
            {
                File = RelativePath,
                Line = name.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                EndLine = node.GetLocation().GetLineSpan().EndLinePosition.Line + 1,
            }, name.SpanStart);
        }

        base.VisitInvocationExpression(node);
    }

    public override void VisitObjectCreationExpression(ObjectCreationExpressionSyntax node)
    {
        HandleCreation(node);
        base.VisitObjectCreationExpression(node);
    }

    public override void VisitImplicitObjectCreationExpression(ImplicitObjectCreationExpressionSyntax node)
    {
        HandleCreation(node);
        base.VisitImplicitObjectCreationExpression(node);
    }

    private void HandleCreation(ExpressionSyntax node)
    {
        var type = _model.GetTypeInfo(node).Type ?? (GetSymbol(node) as IMethodSymbol)?.ContainingType;
        var parent = node.Parent;
        while (parent is ParenthesizedExpressionSyntax) parent = parent.Parent;
        var kind = parent is ThrowStatementSyntax or ThrowExpressionSyntax ? EdgeKinds.Throws : EdgeKinds.Instantiates;
        AddTypeEdge(type, kind, kind == EdgeKinds.Instantiates ? node : null);
    }

    public override void VisitCatchDeclaration(CatchDeclarationSyntax node)
    {
        AddTypeEdge(_model.GetTypeInfo(node.Type).Type, EdgeKinds.Catches);
        base.VisitCatchDeclaration(node);
    }

    public override void VisitAttribute(AttributeSyntax node)
    {
        var attributeType = (GetSymbol(node) as IMethodSymbol)?.ContainingType ?? _model.GetTypeInfo(node).Type;
        AddTypeEdge(attributeType, EdgeKinds.DecoratedWith);
        if (node.ArgumentList == null) return;
        var previous = Context;
        Context = EdgeKinds.Uses;
        try { Visit(node.ArgumentList); }
        finally { Context = previous; }
    }

    // Lambdas and local functions inside a body still belong to the enclosing member: keep walking with "uses".
    public override void VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node) => WithContext(EdgeKinds.Uses, () => base.VisitParenthesizedLambdaExpression(node));
    public override void VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node) => WithContext(EdgeKinds.Uses, () => base.VisitSimpleLambdaExpression(node));
    public override void VisitEqualsValueClause(EqualsValueClauseSyntax node) => WithContext(EdgeKinds.Uses, () => base.VisitEqualsValueClause(node));

    private void WithContext(string context, Action action)
    {
        var previous = Context;
        Context = context;
        try { action(); }
        finally { Context = previous; }
    }

    // ------------------------------------------------------------------ helpers

    private ISymbol? GetSymbol(SyntaxNode node) => Choose(_model.GetSymbolInfo(node), node);

    /// <summary>
    /// The symbol a name stands for. When the compiler could not decide (overload resolution failed, often because a
    /// type in the arguments is unresolved), only the overloads that can take the call's arguments count (their number,
    /// and the parameters of each lambda): the first of them, or nothing when none fits – an overload that cannot take
    /// the arguments is never the one called.
    /// </summary>
    internal static ISymbol? Choose(SymbolInfo info, SyntaxNode node)
    {
        if (info.Symbol != null) return info.Symbol;
        var candidates = info.CandidateSymbols;
        if (candidates.Length <= 1) return candidates.FirstOrDefault();
        if (!candidates.All(c => c is IMethodSymbol) || ArgumentsOf(node) is not { } arguments) return candidates[0];
        return candidates.Cast<IMethodSymbol>().FirstOrDefault(m => Accepts(m, arguments));
    }

    /// <summary>Whether a method takes this many arguments, and each lambda argument goes to a delegate with as many parameters.</summary>
    private static bool Accepts(IMethodSymbol method, IReadOnlyList<ArgumentSyntax> arguments)
    {
        var parameters = method.Parameters;
        var required = parameters.Count(p => !p.IsOptional && !p.IsParams);
        if (arguments.Count < required || (arguments.Count > parameters.Length && !parameters.Any(p => p.IsParams))) return false;
        for (var i = 0; i < arguments.Count && i < parameters.Length; i++)
        {
            if (arguments[i].NameColon != null) break; // named arguments: positions no longer line up
            var lambdaParameters = arguments[i].Expression switch
            {
                SimpleLambdaExpressionSyntax => 1,
                ParenthesizedLambdaExpressionSyntax lambda => lambda.ParameterList.Parameters.Count,
                _ => -1,
            };
            if (lambdaParameters >= 0 && DelegateArity(parameters[i].Type) is { } arity && arity != lambdaParameters) return false;
        }

        return true;
    }

    /// <summary>How many parameters a delegate type takes; Action&lt;…&gt; and Func&lt;…&gt; are counted by name when they do not resolve.</summary>
    private static int? DelegateArity(ITypeSymbol type) => type switch
    {
        INamedTypeSymbol { DelegateInvokeMethod: { } invoke } => invoke.Parameters.Length,
        INamedTypeSymbol { Name: "Action" } named => named.TypeArguments.Length,
        INamedTypeSymbol { Name: "Func", TypeArguments.Length: > 0 } named => named.TypeArguments.Length - 1,
        _ => null,
    };

    /// <summary>The arguments of the call or creation a name belongs to; null if it belongs to none.</summary>
    private static IReadOnlyList<ArgumentSyntax>? ArgumentsOf(SyntaxNode node)
    {
        var expression = node.Parent is MemberAccessExpressionSyntax access && access.Name == node ? access : node;
        return expression.Parent switch
        {
            InvocationExpressionSyntax invocation when invocation.Expression == expression => invocation.ArgumentList.Arguments,
            _ => node switch
            {
                InvocationExpressionSyntax invocation => invocation.ArgumentList.Arguments,
                BaseObjectCreationExpressionSyntax creation => (IReadOnlyList<ArgumentSyntax>?)creation.ArgumentList?.Arguments ?? Array.Empty<ArgumentSyntax>(),
                _ => null,
            },
        };
    }

    /// <summary>True when the name is the type of a <c>new</c>, an attribute or a catch clause – those are recorded elsewhere.</summary>
    private static bool IsSpecialTypePosition(SimpleNameSyntax node)
    {
        SyntaxNode current = node;
        while (current.Parent is QualifiedNameSyntax q && q.Right == current || current.Parent is AliasQualifiedNameSyntax a && a.Name == current)
        {
            current = current.Parent;
        }

        if (current.Parent is NullableTypeSyntax) current = current.Parent;

        return current.Parent switch
        {
            ObjectCreationExpressionSyntax creation => creation.Type == current,
            AttributeSyntax attribute => attribute.Name == current,
            CatchDeclarationSyntax catchDeclaration => catchDeclaration.Type == current,
            _ => false,
        };
    }

    private static bool IsSubscription(SimpleNameSyntax node)
    {
        SyntaxNode current = node;
        if (current.Parent is MemberAccessExpressionSyntax access && access.Name == current) current = access;
        return current.Parent is AssignmentExpressionSyntax assignment
               && assignment.Left == current
               && assignment.Kind() is SyntaxKind.AddAssignmentExpression or SyntaxKind.SubtractAssignmentExpression;
    }

    /// <param name="at">Where the reference occurs; given for calls and instantiations so the call order is known.</param>
    private void AddTypeEdge(ITypeSymbol? type, string kind, SyntaxNode? at = null)
    {
        var named = GraphBuilder.UnwrapType(type);
        if (named == null) return;
        if (IsSelf(named) && kind is not (EdgeKinds.Inherits or EdgeKinds.Implements)) return;
        _builder.AddEdge(_source, _builder.TypeKey(named), kind, LineOf(at));
    }

    private void AddMemberEdge(ISymbol member, string kind, SyntaxNode? at = null)
    {
        _builder.AddEdge(_source, _builder.MemberKey(member), kind, LineOf(at));
    }

    private static int LineOf(SyntaxNode? node) => node == null ? 0 : node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    private bool IsSelf(INamedTypeSymbol type)
    {
        for (var t = _selfType; t != null; t = t.ContainingType)
        {
            if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, type)) return true;
        }

        return false;
    }
}
