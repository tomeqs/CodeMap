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

    public ReferenceWalker(GraphBuilder builder, SemanticModel model) : base(SyntaxWalkerDepth.Node)
    {
        _builder = builder;
        _model = model;
    }

    public string Context { get; private set; } = EdgeKinds.Uses;

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
        if (node.IsVar || node.Parent is NameColonSyntax) return;
        var symbol = GetSymbol(node);
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
                AddMemberEdge(method, EdgeKinds.Calls);
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
        AddTypeEdge(type, kind);
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

    private ISymbol? GetSymbol(SyntaxNode node)
    {
        var info = _model.GetSymbolInfo(node);
        return info.Symbol ?? (info.CandidateSymbols.Length > 0 ? info.CandidateSymbols[0] : null);
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

    private void AddTypeEdge(ITypeSymbol? type, string kind)
    {
        var named = GraphBuilder.UnwrapType(type);
        if (named == null) return;
        if (IsSelf(named) && kind is not (EdgeKinds.Inherits or EdgeKinds.Implements)) return;
        _builder.AddEdge(_source, _builder.TypeKey(named), kind);
    }

    private void AddMemberEdge(ISymbol member, string kind)
    {
        _builder.AddEdge(_source, _builder.MemberKey(member), kind);
    }

    private bool IsSelf(INamedTypeSymbol type)
    {
        for (var t = _selfType; t != null; t = t.ContainingType)
        {
            if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, type)) return true;
        }

        return false;
    }
}
