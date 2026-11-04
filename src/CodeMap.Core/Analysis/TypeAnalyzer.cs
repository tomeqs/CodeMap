using System.Collections.Immutable;
using CodeMap.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMap.Analysis;

/// <summary>Analyzes one syntax tree: declares type / member nodes and walks their code for references.</summary>
internal sealed class TypeAnalyzer
{
    private readonly GraphBuilder _builder;
    private readonly SemanticModel _model;
    private readonly string _projectName;
    private readonly string _relativePath;
    private readonly bool _isTestProject;
    private readonly ReferenceWalker _walker;

    public TypeAnalyzer(GraphBuilder builder, SemanticModel model, string projectName, bool isTestProject)
    {
        _builder = builder;
        _model = model;
        _projectName = projectName;
        _isTestProject = isTestProject;
        _relativePath = Path.GetRelativePath(builder.Root, model.SyntaxTree.FilePath).Replace('\\', '/');
        _walker = new ReferenceWalker(builder, model) { RelativePath = _relativePath };
    }

    public void Run(CancellationToken ct)
    {
        var root = (CompilationUnitSyntax)_model.SyntaxTree.GetRoot(ct);

        if (root.Members.Any(m => m is GlobalStatementSyntax)) ProcessTopLevelStatements(root);

        foreach (var node in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax))
        {
            ct.ThrowIfCancellationRequested();
            switch (node)
            {
                case BaseTypeDeclarationSyntax type:
                    ProcessType(type);
                    break;
                case DelegateDeclarationSyntax @delegate:
                    ProcessDelegate(@delegate);
                    break;
            }
        }
    }

    // ------------------------------------------------------------------ types

    public static string KindOf(INamedTypeSymbol type) => type.TypeKind switch
    {
        TypeKind.Interface => NodeKinds.Interface,
        TypeKind.Struct => type.IsRecord ? NodeKinds.RecordStruct : NodeKinds.Struct,
        TypeKind.Enum => NodeKinds.Enum,
        TypeKind.Delegate => NodeKinds.Delegate,
        _ => type.IsRecord ? NodeKinds.Record : NodeKinds.Class,
    };

    private string ParentKeyOf(INamedTypeSymbol type) =>
        type.ContainingType != null
            ? GraphBuilder.SymbolKey(type.ContainingType.OriginalDefinition)!
            : _builder.EnsureNamespace(_projectName, type.ContainingNamespace);

    private (string Key, GraphBuilder.NodeDraft Draft)? DeclareType(INamedTypeSymbol type, SyntaxNode declaration)
    {
        var key = GraphBuilder.SymbolKey(type);
        if (key == null) return null;

        var draft = _builder.GetOrAddNode(key, () =>
        {
            var node = new GraphNode
            {
                Kind = KindOf(type),
                Name = type.ToDisplayString(SymbolFormats.ShortType),
                FullName = type.ToDisplayString(SymbolFormats.FullType),
                Parent = ParentKeyOf(type),
                Project = _builder.ProjectKey(_projectName),
                Namespace = type.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString(SymbolFormats.Namespace) : null,
                Accessibility = SymbolFormats.Accessibility(type.DeclaredAccessibility),
                Modifiers = TypeModifiers(type),
                Doc = SymbolFormats.Summary(type),
                Attributes = AttributeNames(type),
            };
            node.Signature = TypeSignature(type, node);
            if (type.TypeParameters.Length > 0) node.SetMetric("typeParameters", type.TypeParameters.Length);
            return node;
        });

        _builder.AddLocation(draft, LocationOf(declaration));
        if (declaration is TypeDeclarationSyntax td && td.Modifiers.Any(SyntaxKind.PartialKeyword))
        {
            lock (draft)
            {
                draft.Node.Modifiers ??= new List<string>();
                if (!draft.Node.Modifiers.Contains("partial")) draft.Node.Modifiers.Add("partial");
            }
        }

        if (_builder.Once("relations:" + key)) EmitTypeRelations(type, key, draft.Node);
        return (key, draft);
    }

    private void ProcessType(BaseTypeDeclarationSyntax declaration)
    {
        if (declaration.Kind() == SyntaxKind.ExtensionBlockDeclaration)
        {
            ProcessExtensionBlock((TypeDeclarationSyntax)declaration);
            return;
        }

        if (_model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol type) return;
        var declared = DeclareType(type, declaration);
        if (declared == null) return;
        var (key, draft) = declared.Value;

        _walker.Walk(declaration.AttributeLists, key, type, EdgeKinds.Uses);

        if (declaration is EnumDeclarationSyntax enumDeclaration)
        {
            lock (draft) draft.Node.SetMetric("enumMembers", draft.Node.Metric("enumMembers") + enumDeclaration.Members.Count);
            foreach (var member in enumDeclaration.Members)
            {
                _walker.Walk(member.AttributeLists, key, type, EdgeKinds.Uses);
                _walker.Walk(member.EqualsValue, key, type, EdgeKinds.Uses);
            }

            return;
        }

        if (declaration is not TypeDeclarationSyntax typeDeclaration) return;

        _walker.Walk(typeDeclaration.ConstraintClauses, key, type, EdgeKinds.Uses);

        // Primary constructors: records turn parameters into properties, classes/structs capture dependencies.
        if (typeDeclaration.ParameterList is { } parameters)
        {
            if (type.IsRecord)
            {
                foreach (var parameter in parameters.Parameters)
                {
                    var property = type.GetMembers(parameter.Identifier.ValueText).OfType<IPropertySymbol>().FirstOrDefault();
                    var propertyKey = property != null ? DeclareMember(property, NodeKinds.Property, key, parameter, parameter, isPositional: true) : null;
                    _walker.Walk(parameter.Type, propertyKey ?? key, type, EdgeKinds.Holds);
                    _walker.Walk(parameter.AttributeLists, propertyKey ?? key, type, EdgeKinds.Uses);
                    _walker.Walk(parameter.Default, propertyKey ?? key, type, EdgeKinds.Uses);
                }
            }
            else
            {
                _walker.Walk(parameters, key, type, EdgeKinds.Injects);
            }
        }

        if (typeDeclaration.BaseList != null)
        {
            foreach (var baseType in typeDeclaration.BaseList.Types)
            {
                if (baseType is PrimaryConstructorBaseTypeSyntax primary) _walker.Walk(primary.ArgumentList, key, type, EdgeKinds.Uses);

                // IRepository<Order>, AbstractValidator<Order>: the base itself is inherits / implements (EmitTypeRelations),
                // its type arguments are dependencies too. Only the outermost lists: the walker visits nested ones itself.
                foreach (var arguments in baseType.Type.DescendantNodesAndSelf(n => n is not TypeArgumentListSyntax).OfType<TypeArgumentListSyntax>())
                {
                    _walker.Walk(arguments, key, type, EdgeKinds.Uses);
                }
            }
        }

        foreach (var member in typeDeclaration.Members) ProcessMember(member, type, key);
    }

    private void ProcessDelegate(DelegateDeclarationSyntax declaration)
    {
        if (_model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol type) return;
        var declared = DeclareType(type, declaration);
        if (declared == null) return;
        var key = declared.Value.Key;
        _walker.Walk(declaration.AttributeLists, key, type, EdgeKinds.Uses);
        _walker.Walk(declaration.ReturnType, key, type, EdgeKinds.Returns);
        _walker.Walk(declaration.ParameterList, key, type, EdgeKinds.Accepts);
    }

    /// <summary>C# 14 <c>extension(T receiver) { ... }</c> blocks: members belong to the enclosing static class.</summary>
    private void ProcessExtensionBlock(TypeDeclarationSyntax block)
    {
        if (block.Parent is not TypeDeclarationSyntax container || _model.GetDeclaredSymbol(container) is not INamedTypeSymbol containerType) return;
        var containerKey = GraphBuilder.SymbolKey(containerType);
        if (containerKey == null) return;

        if (block.ParameterList is { Parameters.Count: > 0 } receiver)
        {
            var receiverType = _model.GetTypeInfo(receiver.Parameters[0].Type!).Type;
            _builder.AddEdge(containerKey, _builder.TypeKey(receiverType), EdgeKinds.Extends);
        }

        foreach (var member in block.Members) ProcessMember(member, containerType, containerKey);
    }

    private void EmitTypeRelations(INamedTypeSymbol type, string key, GraphNode node)
    {
        if (type.BaseType is { } baseType && !IsTrivialBase(baseType))
        {
            node.BaseType = baseType.ToDisplayString(SymbolFormats.FullType);
            _builder.AddEdge(key, _builder.TypeKey(baseType), EdgeKinds.Inherits);
        }

        foreach (var @interface in type.Interfaces)
        {
            _builder.AddEdge(key, _builder.TypeKey(@interface), type.TypeKind == TypeKind.Interface ? EdgeKinds.Inherits : EdgeKinds.Implements);
        }

        if (type.TypeKind is TypeKind.Class or TypeKind.Struct)
        {
            // Member-level "implements": which method fulfils which interface member.
            foreach (var @interface in type.AllInterfaces)
            {
                if (!_builder.IsInternal(@interface)) continue;
                foreach (var interfaceMember in @interface.GetMembers())
                {
                    if (interfaceMember is not (IMethodSymbol { MethodKind: MethodKind.Ordinary } or IPropertySymbol or IEventSymbol)) continue;
                    ISymbol? implementation;
                    try { implementation = type.FindImplementationForInterfaceMember(interfaceMember); }
                    catch { continue; }
                    if (implementation == null || !SymbolEqualityComparer.Default.Equals(implementation.ContainingType?.OriginalDefinition, type.OriginalDefinition)) continue;
                    _builder.AddEdge(_builder.MemberKey(implementation), _builder.MemberKey(interfaceMember), EdgeKinds.Implements);
                }
            }

            var depth = 0;
            for (var t = type.BaseType; t != null; t = t.BaseType) depth++;
            if (type.TypeKind == TypeKind.Class) node.SetMetric("dit", depth);
        }

        Tagger.TagType(type, node, _isTestProject);
        if (type.TypeKind is TypeKind.Class or TypeKind.Struct && !type.IsStatic && !type.IsAbstract) RecordConstructor(type, key);
    }

    /// <summary>What a DI container would have to supply: the parameters of the widest public constructor.</summary>
    private void RecordConstructor(INamedTypeSymbol type, string key)
    {
        var constructor = type.InstanceConstructors
            .Where(c => c.DeclaredAccessibility == Microsoft.CodeAnalysis.Accessibility.Public)
            .OrderByDescending(c => c.Parameters.Length)
            .FirstOrDefault();

        var dependencies = new List<GraphBuilder.DependencyDraft>();
        void Add(ITypeSymbol type, bool optional, string? serviceKey)
        {
            var many = false;
            if (type is INamedTypeSymbol { IsGenericType: true } generic
                && generic.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T)
            {
                type = generic.TypeArguments[0];
                many = true;
            }

            if (type.IsValueType) return; // enums, numbers, structs: never container services
            var ident = _builder.ServiceIdent(type);
            if (ident != null) dependencies.Add(new GraphBuilder.DependencyDraft(ident, many, optional, serviceKey));
        }

        foreach (var parameter in constructor?.Parameters ?? ImmutableArray<IParameterSymbol>.Empty)
        {
            Add(parameter.Type, parameter.HasExplicitDefaultValue, DiRegistrationDetector.KeyOf(parameter));
        }

        // Blazor: [Inject] properties are filled by the renderer from the container (the key from [Inject(Key = …)]).
        for (var current = type; current != null && current.Locations.Any(l => l.IsInSource); current = current.BaseType)
        {
            foreach (var property in current.GetMembers().OfType<IPropertySymbol>())
            {
                var inject = property.GetAttributes().FirstOrDefault(a => a.AttributeClass?.Name is "InjectAttribute" or "Inject");
                if (inject == null) continue;
                var serviceKey = inject.NamedArguments.FirstOrDefault(a => a.Key == "Key").Value is { Value: { } value } typed ? DiRegistrationDetector.KeyText(value, typed.Type) : null;
                Add(property.Type, optional: false, serviceKey);
            }
        }

        if (dependencies.Count > 0) _builder.SetConstructorDependencies(key, dependencies);
    }

    private static bool IsTrivialBase(INamedTypeSymbol baseType) =>
        baseType.SpecialType is SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum
            or SpecialType.System_MulticastDelegate or SpecialType.System_Delegate;

    // ------------------------------------------------------------------ members

    private void ProcessMember(MemberDeclarationSyntax member, INamedTypeSymbol type, string typeKey)
    {
        switch (member)
        {
            case MethodDeclarationSyntax method when _model.GetDeclaredSymbol(method) is IMethodSymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Method, typeKey, method, method);
                _walker.Walk(method.AttributeLists, key, type, EdgeKinds.Uses);
                _walker.Walk(method.ReturnType, key, type, EdgeKinds.Returns);
                _walker.Walk(method.ParameterList, key, type, EdgeKinds.Accepts);
                _walker.Walk(method.ConstraintClauses, key, type, EdgeKinds.Uses);
                _walker.Walk(method.Body, key, type, EdgeKinds.Uses);
                _walker.Walk(method.ExpressionBody, key, type, EdgeKinds.Uses);
                if (symbol.IsExtensionMethod && symbol.Parameters.Length > 0)
                {
                    _builder.AddEdge(key, _builder.TypeKey(symbol.Parameters[0].Type), EdgeKinds.Extends);
                }

                if (symbol.OverriddenMethod is { } overridden) AddOverride(key, overridden);
                break;
            }
            case ConstructorDeclarationSyntax constructor when _model.GetDeclaredSymbol(constructor) is IMethodSymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Constructor, typeKey, constructor, constructor);
                _walker.Walk(constructor.AttributeLists, key, type, EdgeKinds.Uses);
                // Constructor parameters are the type's dependencies (constructor injection).
                _walker.Walk(constructor.ParameterList, symbol.IsStatic ? key : typeKey, type, symbol.IsStatic ? EdgeKinds.Accepts : EdgeKinds.Injects);
                _walker.Walk(constructor.Initializer, key, type, EdgeKinds.Uses);
                _walker.Walk(constructor.Body, key, type, EdgeKinds.Uses);
                _walker.Walk(constructor.ExpressionBody, key, type, EdgeKinds.Uses);
                break;
            }
            case DestructorDeclarationSyntax destructor when _model.GetDeclaredSymbol(destructor) is IMethodSymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Method, typeKey, destructor, destructor);
                _walker.Walk(destructor.Body, key, type, EdgeKinds.Uses);
                _walker.Walk(destructor.ExpressionBody, key, type, EdgeKinds.Uses);
                break;
            }
            case OperatorDeclarationSyntax op when _model.GetDeclaredSymbol(op) is IMethodSymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Method, typeKey, op, op);
                _walker.Walk(op.ReturnType, key, type, EdgeKinds.Returns);
                _walker.Walk(op.ParameterList, key, type, EdgeKinds.Accepts);
                _walker.Walk(op.Body, key, type, EdgeKinds.Uses);
                _walker.Walk(op.ExpressionBody, key, type, EdgeKinds.Uses);
                break;
            }
            case ConversionOperatorDeclarationSyntax conversion when _model.GetDeclaredSymbol(conversion) is IMethodSymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Method, typeKey, conversion, conversion);
                _walker.Walk(conversion.Type, key, type, EdgeKinds.Returns);
                _walker.Walk(conversion.ParameterList, key, type, EdgeKinds.Accepts);
                _walker.Walk(conversion.Body, key, type, EdgeKinds.Uses);
                _walker.Walk(conversion.ExpressionBody, key, type, EdgeKinds.Uses);
                break;
            }
            case PropertyDeclarationSyntax property when _model.GetDeclaredSymbol(property) is IPropertySymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Property, typeKey, property, property);
                _walker.Walk(property.AttributeLists, key, type, EdgeKinds.Uses);
                _walker.Walk(property.Type, key, type, EdgeKinds.Holds);
                _walker.Walk(property.AccessorList, key, type, EdgeKinds.Uses);
                _walker.Walk(property.ExpressionBody, key, type, EdgeKinds.Uses);
                _walker.Walk(property.Initializer, key, type, EdgeKinds.Uses);
                if (symbol.OverriddenProperty is { } overridden) AddOverride(key, overridden);
                break;
            }
            case IndexerDeclarationSyntax indexer when _model.GetDeclaredSymbol(indexer) is IPropertySymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Property, typeKey, indexer, indexer);
                _walker.Walk(indexer.AttributeLists, key, type, EdgeKinds.Uses);
                _walker.Walk(indexer.Type, key, type, EdgeKinds.Returns);
                _walker.Walk(indexer.ParameterList, key, type, EdgeKinds.Accepts);
                _walker.Walk(indexer.AccessorList, key, type, EdgeKinds.Uses);
                _walker.Walk(indexer.ExpressionBody, key, type, EdgeKinds.Uses);
                if (symbol.OverriddenProperty is { } overridden) AddOverride(key, overridden);
                break;
            }
            case EventDeclarationSyntax @event when _model.GetDeclaredSymbol(@event) is IEventSymbol symbol:
            {
                var key = DeclareMember(symbol, NodeKinds.Event, typeKey, @event, @event);
                _walker.Walk(@event.AttributeLists, key, type, EdgeKinds.Uses);
                _walker.Walk(@event.Type, key, type, EdgeKinds.Holds);
                _walker.Walk(@event.AccessorList, key, type, EdgeKinds.Uses);
                if (symbol.OverriddenEvent is { } overridden) AddOverride(key, overridden);
                break;
            }
            case BaseFieldDeclarationSyntax field:
            {
                var isEvent = field is EventFieldDeclarationSyntax;
                foreach (var variable in field.Declaration.Variables)
                {
                    var symbol = _model.GetDeclaredSymbol(variable);
                    if (symbol is not (IFieldSymbol or IEventSymbol)) continue;
                    var key = DeclareMember(symbol, isEvent ? NodeKinds.Event : NodeKinds.Field, typeKey, field, variable);
                    _walker.Walk(field.AttributeLists, key, type, EdgeKinds.Uses);
                    _walker.Walk(field.Declaration.Type, key, type, EdgeKinds.Holds);
                    _walker.Walk(variable.Initializer, key, type, EdgeKinds.Uses);
                }

                break;
            }
        }
    }

    private void AddOverride(string? key, ISymbol overridden)
    {
        if (_builder.IsInternal(overridden)) _builder.AddEdge(key, _builder.MemberKey(overridden), EdgeKinds.Overrides);
    }

    /// <param name="declaration">Syntax used for location / size / complexity.</param>
    /// <param name="locationNode">Syntax whose line span is reported (a single field variable, a positional parameter...).</param>
    private string? DeclareMember(ISymbol symbol, string kind, string typeKey, SyntaxNode declaration, SyntaxNode locationNode, bool isPositional = false)
    {
        var key = GraphBuilder.SymbolKey(GraphBuilder.Normalize(symbol));
        if (key == null) return null;

        var isField = kind == NodeKinds.Field || declaration is EventFieldDeclarationSyntax;
        var draft = _builder.GetOrAddNode(key, () =>
        {
            var node = new GraphNode
            {
                Kind = kind,
                Name = MemberName(symbol),
                FullName = symbol.ContainingType.ToDisplayString(SymbolFormats.FullType) + "." + MemberName(symbol),
                Parent = typeKey,
                Project = _builder.ProjectKey(_projectName),
                Namespace = symbol.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString(SymbolFormats.Namespace) : null,
                Accessibility = SymbolFormats.Accessibility(symbol.DeclaredAccessibility),
                Modifiers = MemberModifiers(symbol),
                Signature = SafeSignature(symbol),
                Doc = SymbolFormats.Summary(symbol),
                Attributes = AttributeNames(symbol),
            };

            if (symbol is IMethodSymbol method && method.Parameters.Length > 0) node.SetMetric("parameters", method.Parameters.Length);
            if (isPositional) node.AddTag("positional");
            Tagger.TagMember(symbol, node);
            return node;
        });

        var location = LocationOf(isField || isPositional ? locationNode : declaration);
        _builder.AddLocation(draft, location);

        // Cyclomatic complexity for anything with code; auto-properties, fields and positional properties only count their initializers.
        var hasCode = !isField && !isPositional && HasCode(declaration);
        var decisions = Complexity.DecisionPoints(isField ? (locationNode as VariableDeclaratorSyntax)?.Initializer : isPositional ? null : declaration);
        lock (draft)
        {
            if (hasCode || decisions > 0) draft.Node.SetMetric("complexity", draft.Node.Metric("complexity") + (hasCode ? 1 : 0) + decisions);
        }

        return key;
    }

    private static bool HasCode(SyntaxNode declaration) => declaration switch
    {
        BaseMethodDeclarationSyntax method => method.Body != null || method.ExpressionBody != null,
        PropertyDeclarationSyntax property => property.ExpressionBody != null || HasAccessorBodies(property.AccessorList),
        IndexerDeclarationSyntax indexer => indexer.ExpressionBody != null || HasAccessorBodies(indexer.AccessorList),
        EventDeclarationSyntax @event => HasAccessorBodies(@event.AccessorList),
        _ => false,
    };

    private static bool HasAccessorBodies(AccessorListSyntax? accessors) =>
        accessors?.Accessors.Any(a => a.Body != null || a.ExpressionBody != null) == true;

    // ------------------------------------------------------------------ top-level statements

    private void ProcessTopLevelStatements(CompilationUnitSyntax root)
    {
        var statements = root.Members.OfType<GlobalStatementSyntax>().ToList();
        // The enclosing symbol of a top-level statement is the synthesized <Main>$ method (works for libraries too).
        var entryPoint = _model.GetEnclosingSymbol(statements[0].Statement.SpanStart) as IMethodSymbol
                         ?? _model.Compilation.GetEntryPoint(CancellationToken.None);
        if (entryPoint?.ContainingType == null) return;
        var type = entryPoint.ContainingType;

        var declared = DeclareType(type, root);
        if (declared == null) return;
        var (typeKey, typeDraft) = declared.Value;
        typeDraft.Node.AddTag(Tags.EntryPoint);

        var key = GraphBuilder.SymbolKey(entryPoint);
        if (key == null) return;
        var draft = _builder.GetOrAddNode(key, () =>
        {
            var node = new GraphNode
            {
                Kind = NodeKinds.Method,
                Name = "Main (top-level statements)",
                FullName = type.ToDisplayString(SymbolFormats.FullType) + ".Main",
                Parent = typeKey,
                Project = _builder.ProjectKey(_projectName),
                Accessibility = "private",
                Modifiers = new List<string> { "static" },
                Signature = "static void Main(string[] args)",
            };
            node.AddTag(Tags.EntryPoint);
            return node;
        });

        var first = statements[0].GetLocation().GetLineSpan();
        var last = statements[^1].GetLocation().GetLineSpan();
        _builder.AddLocation(draft, new SourceLocation { File = _relativePath, Line = first.StartLinePosition.Line + 1, EndLine = last.EndLinePosition.Line + 1 });
        var decisions = statements.Sum(s => Complexity.DecisionPoints(s));
        lock (draft) draft.Node.SetMetric("complexity", 1 + decisions);

        foreach (var statement in statements) _walker.Walk(statement, key, type, EdgeKinds.Uses);
    }

    // ------------------------------------------------------------------ formatting helpers

    private SourceLocation LocationOf(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return new SourceLocation
        {
            File = _relativePath,
            Line = span.StartLinePosition.Line + 1,
            EndLine = span.EndLinePosition.Line + 1,
        };
    }

    private static string MemberName(ISymbol symbol) => symbol switch
    {
        IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } m => m.ContainingType.Name,
        IMethodSymbol { MethodKind: MethodKind.Destructor } m => "~" + m.ContainingType.Name,
        IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator or MethodKind.Conversion } m => m.ToDisplayString(SymbolFormats.ShortType),
        IPropertySymbol { IsIndexer: true } => "this[]",
        IMethodSymbol { ExplicitInterfaceImplementations.Length: > 0 } m => m.ExplicitInterfaceImplementations[0].ContainingType.Name + "." + m.ExplicitInterfaceImplementations[0].Name,
        IPropertySymbol { ExplicitInterfaceImplementations.Length: > 0 } p => p.ExplicitInterfaceImplementations[0].ContainingType.Name + "." + p.ExplicitInterfaceImplementations[0].Name,
        IEventSymbol { ExplicitInterfaceImplementations.Length: > 0 } e => e.ExplicitInterfaceImplementations[0].ContainingType.Name + "." + e.ExplicitInterfaceImplementations[0].Name,
        IMethodSymbol { IsGenericMethod: true } m => m.Name + "<" + string.Join(", ", m.TypeParameters.Select(t => t.Name)) + ">",
        _ => symbol.Name,
    };

    private static string? SafeSignature(ISymbol symbol)
    {
        try { return symbol.ToDisplayString(SymbolFormats.MemberSignature); }
        catch { return null; }
    }

    private static string TypeSignature(INamedTypeSymbol type, GraphNode node)
    {
        var keyword = type.TypeKind switch
        {
            TypeKind.Interface => "interface",
            TypeKind.Enum => "enum",
            TypeKind.Delegate => "delegate",
            TypeKind.Struct => type.IsRecord ? "record struct" : "struct",
            _ => type.IsRecord ? "record" : "class",
        };
        var parts = new List<string> { node.Accessibility ?? "" };
        if (node.Modifiers != null) parts.AddRange(node.Modifiers);
        parts.Add(keyword);
        parts.Add(node.Name);
        var bases = new List<string>();
        if (type.BaseType is { } b && !IsTrivialBase(b)) bases.Add(b.ToDisplayString(SymbolFormats.ShortType));
        bases.AddRange(type.Interfaces.Select(i => i.ToDisplayString(SymbolFormats.ShortType)));
        var signature = string.Join(' ', parts.Where(p => p.Length > 0));
        return bases.Count > 0 ? signature + " : " + string.Join(", ", bases) : signature;
    }

    private static List<string>? TypeModifiers(INamedTypeSymbol type)
    {
        var modifiers = new List<string>();
        if (type.IsStatic) modifiers.Add("static");
        else if (type.IsAbstract && type.TypeKind == TypeKind.Class) modifiers.Add("abstract");
        if (type.IsSealed && type.TypeKind == TypeKind.Class && !type.IsStatic) modifiers.Add("sealed");
        if (type.IsReadOnly && type.TypeKind == TypeKind.Struct) modifiers.Add("readonly");
        if (type.IsRefLikeType) modifiers.Add("ref");
        if (type.IsFileLocal) modifiers.Add("file");
        return modifiers.Count > 0 ? modifiers : null;
    }

    private static List<string>? MemberModifiers(ISymbol symbol)
    {
        var modifiers = new List<string>();
        if (symbol.IsStatic) modifiers.Add("static");
        if (symbol.IsAbstract && symbol.ContainingType?.TypeKind != TypeKind.Interface) modifiers.Add("abstract");
        if (symbol.IsVirtual) modifiers.Add("virtual");
        if (symbol.IsOverride) modifiers.Add("override");
        if (symbol.IsSealed && symbol.IsOverride) modifiers.Add("sealed");
        if (symbol.IsExtern) modifiers.Add("extern");
        switch (symbol)
        {
            case IMethodSymbol method:
                if (method.IsAsync) modifiers.Add("async");
                if (method.IsExtensionMethod) modifiers.Add("extension");
                break;
            case IFieldSymbol field:
                if (field.IsConst) modifiers.Add("const");
                if (field.IsReadOnly) modifiers.Add("readonly");
                if (field.IsVolatile) modifiers.Add("volatile");
                if (field.IsRequired) modifiers.Add("required");
                break;
            case IPropertySymbol property:
                if (property.IsRequired) modifiers.Add("required");
                if (property.IsReadOnly) modifiers.Add("readonly");
                if (property.SetMethod?.IsInitOnly == true) modifiers.Add("init");
                break;
        }

        return modifiers.Count > 0 ? modifiers : null;
    }

    private static List<string>? AttributeNames(ISymbol symbol)
    {
        var names = symbol.GetAttributes()
            .Select(a => a.AttributeClass?.Name)
            .Where(n => !string.IsNullOrEmpty(n))
            .Select(n => n!.EndsWith("Attribute", StringComparison.Ordinal) && n.Length > 9 ? n[..^9] : n!)
            .Distinct()
            .ToList();
        return names.Count > 0 ? names : null;
    }
}
