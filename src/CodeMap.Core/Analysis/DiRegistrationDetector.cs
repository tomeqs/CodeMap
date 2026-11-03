using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMap.Analysis;

/// <summary>A service registration recognised in code, still in Roslyn terms.</summary>
/// <param name="IfMissing">TryAdd*: the container skips it when the service (and key) is already registered.</param>
internal sealed record RegistrationCandidate(
    ITypeSymbol? Service,
    string? ServiceName,
    ITypeSymbol? Implementation,
    string Lifetime,
    string Kind,
    string? Key,
    bool IfMissing = false);

/// <summary>
/// Recognises Microsoft.Extensions.DependencyInjection registrations: AddSingleton/AddScoped/AddTransient
/// (generic, typeof, instance and factory forms), TryAdd*, keyed variants, ServiceDescriptor.X,
/// AddHostedService, AddDbContext and typed AddHttpClient.
/// </summary>
internal static class DiRegistrationDetector
{
    public const string Singleton = "singleton";
    public const string Scoped = "scoped";
    public const string Transient = "transient";

    private static readonly Dictionary<string, (string Lifetime, string Kind)> Methods = new(StringComparer.Ordinal)
    {
        ["AddSingleton"] = (Singleton, "type"), ["TryAddSingleton"] = (Singleton, "type"),
        ["AddKeyedSingleton"] = (Singleton, "type"), ["TryAddKeyedSingleton"] = (Singleton, "type"),
        ["AddScoped"] = (Scoped, "type"), ["TryAddScoped"] = (Scoped, "type"),
        ["AddKeyedScoped"] = (Scoped, "type"), ["TryAddKeyedScoped"] = (Scoped, "type"),
        ["AddTransient"] = (Transient, "type"), ["TryAddTransient"] = (Transient, "type"),
        ["AddKeyedTransient"] = (Transient, "type"), ["TryAddKeyedTransient"] = (Transient, "type"),
        ["AddHostedService"] = (Singleton, "hosted"),
        ["AddDbContext"] = (Scoped, "dbcontext"), ["AddDbContextPool"] = (Scoped, "dbcontext"),
        ["AddHttpClient"] = (Transient, "httpclient"),
    };

    private static readonly Dictionary<string, string> DescriptorMethods = new(StringComparer.Ordinal)
    {
        ["Singleton"] = Singleton, ["KeyedSingleton"] = Singleton,
        ["Scoped"] = Scoped, ["KeyedScoped"] = Scoped,
        ["Transient"] = Transient, ["KeyedTransient"] = Transient,
    };

    /// <summary>What each argument of a registration call is for.</summary>
    private sealed class Arguments
    {
        public ExpressionSyntax? ServiceType;
        public ExpressionSyntax? ImplementationType;
        public ExpressionSyntax? Factory;
        public ExpressionSyntax? Instance;
        public ExpressionSyntax? Key;
        public ExpressionSyntax? ContextLifetime;
    }

    /// <summary>The name of the called method (<c>AddScoped</c> in <c>services.AddScoped&lt;T&gt;()</c>).</summary>
    public static SimpleNameSyntax? MethodName(InvocationExpressionSyntax node) => node.Expression switch
    {
        MemberAccessExpressionSyntax access => access.Name,
        SimpleNameSyntax simple => simple,
        MemberBindingExpressionSyntax binding => binding.Name,
        _ => null,
    };

    public static RegistrationCandidate? TryDetect(InvocationExpressionSyntax node, SemanticModel model)
    {
        var name = MethodName(node);
        if (name == null) return null;
        var methodName = name.Identifier.ValueText;

        string lifetime;
        string kind;
        if (Methods.TryGetValue(methodName, out var entry))
        {
            (lifetime, kind) = entry;
        }
        else if (DescriptorMethods.TryGetValue(methodName, out var descriptorLifetime)
                 && node.Expression is MemberAccessExpressionSyntax { Expression: var target }
                 && target.ToString().EndsWith("ServiceDescriptor", StringComparison.Ordinal))
        {
            (lifetime, kind) = (descriptorLifetime, "type");
        }
        else if (methodName.StartsWith("Add", StringComparison.Ordinal) && methodName.EndsWith("DbContext", StringComparison.Ordinal) && name is GenericNameSyntax)
        {
            // Integrations such as Aspire's AddNpgsqlDbContext<T>() / AddSqlServerDbContext<T>() register a scoped context.
            (lifetime, kind) = (Scoped, "dbcontext");
        }
        else
        {
            return null;
        }

        // TryAddX(...), and services.TryAdd(ServiceDescriptor.X(...)).
        var ifMissing = methodName.StartsWith("TryAdd", StringComparison.Ordinal)
                        || (kind == "type" && !Methods.ContainsKey(methodName)
                            && node.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax outer } }
                            && MethodName(outer)?.Identifier.ValueText == "TryAdd");
        var info = model.GetSymbolInfo(node);
        var method = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;

        List<ITypeSymbol?> typeArguments;
        Arguments arguments;
        if (method != null)
        {
            var definition = method.ReducedFrom ?? method;
            var ns = definition.ContainingNamespace?.ToDisplayString() ?? "";
            var trusted = ns.StartsWith("Microsoft.Extensions.DependencyInjection", StringComparison.Ordinal)
                          || (kind == "dbcontext" && ns.StartsWith("Microsoft.", StringComparison.Ordinal));
            if (!trusted) return null;
            typeArguments = method.TypeArguments.Cast<ITypeSymbol?>().ToList();
            arguments = ByParameter(node.ArgumentList.Arguments, method.Parameters);
        }
        else
        {
            // Not resolved (e.g. the DI package was never restored): trust the name, but require type information.
            typeArguments = name is GenericNameSyntax generic
                ? generic.TypeArgumentList.Arguments.Select(t => model.GetTypeInfo(t).Type).ToList()
                : new List<ITypeSymbol?>();
            var list = node.ArgumentList.Arguments;
            if (typeArguments.Count == 0 && !list.Any(a => a.Expression is TypeOfExpressionSyntax) && list.Count != 1) return null;
            arguments = ByPosition(list, kind, keyed: methodName.Contains("Keyed", StringComparison.Ordinal), generic: typeArguments.Count > 0);
        }

        var key = arguments.Key == null ? null : KeyOf(arguments.Key, model);
        ITypeSymbol? TypeOf(ExpressionSyntax? expression) => expression is TypeOfExpressionSyntax typeOf ? model.GetTypeInfo(typeOf.Type).Type : null;
        RegistrationCandidate Candidate(ITypeSymbol? service, ITypeSymbol? implementation, string candidateKind, string? serviceName = null) =>
            new(service, serviceName, implementation, lifetime, candidateKind, key, ifMissing);

        switch (kind)
        {
            case "hosted":
                return typeArguments.Count > 0 ? Candidate(null, typeArguments[0], kind, "Microsoft.Extensions.Hosting.IHostedService") : null;
            case "dbcontext":
            case "httpclient":
                if (typeArguments.Count == 0) return null; // AddHttpClient("name") registers no type of ours
                if (kind == "dbcontext" && LifetimeOf(arguments.ContextLifetime, model) is { } contextLifetime) lifetime = contextLifetime;
                return Candidate(typeArguments[0], typeArguments.Count > 1 ? typeArguments[1] : typeArguments[0], kind);
        }

        var factory = arguments.Factory as AnonymousFunctionExpressionSyntax;
        var service = typeArguments.Count > 0 ? typeArguments[0] : TypeOf(arguments.ServiceType);

        // AddX<IService, Impl>(sp => ...) : the lambda builds Impl, the container does not call its constructor.
        if (typeArguments.Count >= 2) return Candidate(typeArguments[0], typeArguments[1], arguments.Factory != null ? "factory" : "type");

        if (arguments.Factory != null)
        {
            var (implementation, factoryKind) = factory != null ? AnalyzeFactory(factory, model) : (null, "factory");
            service ??= implementation;
            return service == null ? null : Candidate(service, implementation, factoryKind);
        }

        if (arguments.ImplementationType != null) return service == null ? null : Candidate(service, TypeOf(arguments.ImplementationType), "type");

        if (arguments.Instance != null)
        {
            var instanceType = model.GetTypeInfo(arguments.Instance).Type;
            if (instanceType == null || instanceType.TypeKind == TypeKind.Error) return service == null ? null : Candidate(service, service, "instance");
            return Candidate(service ?? instanceType, instanceType, "instance");
        }

        return service == null ? null : Candidate(service, service, "type");
    }

    /// <summary>Arguments of a resolved method, by the name of the parameter they go to (named arguments included).</summary>
    private static Arguments ByParameter(SeparatedSyntaxList<ArgumentSyntax> list, IReadOnlyList<IParameterSymbol> parameters)
    {
        // The static call form ServiceCollectionServiceExtensions.AddX(services, ...) has the collection as
        // parameter 0, so its argument lands on "services" / "collection" and is ignored.
        var result = new Arguments();
        for (var i = 0; i < list.Count; i++)
        {
            var argument = list[i];
            var parameter = argument.NameColon is { } nameColon
                ? parameters.FirstOrDefault(p => p.Name == nameColon.Name.Identifier.ValueText)
                : i < parameters.Count ? parameters[i] : null;
            switch (parameter?.Name)
            {
                case "serviceType" or "service": result.ServiceType = argument.Expression; break;
                case "implementationType": result.ImplementationType = argument.Expression; break;
                case "implementationFactory": result.Factory = argument.Expression; break;
                case "implementationInstance" or "instance": result.Instance = argument.Expression; break;
                case "serviceKey": result.Key = argument.Expression; break;
                case "contextLifetime": result.ContextLifetime = argument.Expression; break;
            }
        }

        return result;
    }

    /// <summary>
    /// Arguments of a call the compiler could not resolve: named ones by their name, the rest by their shape.
    /// typeof(...) is the service type and then the implementation type, a lambda the factory, any other value
    /// the instance. A keyed call's key is its first such value (the first argument of a generic one).
    /// </summary>
    private static Arguments ByPosition(SeparatedSyntaxList<ArgumentSyntax> list, string kind, bool keyed, bool generic)
    {
        var result = new Arguments();
        var positional = new List<ExpressionSyntax>();
        foreach (var argument in list)
        {
            switch (argument.NameColon?.Name.Identifier.ValueText)
            {
                case "serviceType" or "service": result.ServiceType = argument.Expression; break;
                case "implementationType": result.ImplementationType = argument.Expression; break;
                case "implementationFactory": result.Factory = argument.Expression; break;
                case "implementationInstance" or "instance": result.Instance = argument.Expression; break;
                case "serviceKey": result.Key = argument.Expression; break;
                case "contextLifetime": result.ContextLifetime = argument.Expression; break;
                case null: positional.Add(argument.Expression); break;
            }
        }

        if (kind == "dbcontext")
        {
            // AddDbContext<T>(options, contextLifetime, optionsLifetime): the first lifetime is the context's.
            result.ContextLifetime ??= positional.FirstOrDefault(a => a is MemberAccessExpressionSyntax { Expression: var type } && type.ToString().EndsWith("ServiceLifetime", StringComparison.Ordinal));
            return result;
        }

        static bool IsValue(ExpressionSyntax e) => e is not (TypeOfExpressionSyntax or AnonymousFunctionExpressionSyntax);
        if (keyed && result.Key == null)
        {
            result.Key = generic ? positional.FirstOrDefault() : positional.FirstOrDefault(IsValue);
            if (result.Key != null) positional.Remove(result.Key);
        }

        var typeOfs = positional.OfType<TypeOfExpressionSyntax>().ToList();
        if (typeOfs.Count > 0) result.ServiceType ??= typeOfs[0];
        if (typeOfs.Count > 1) result.ImplementationType ??= typeOfs[1];
        result.Factory ??= positional.FirstOrDefault(a => a is AnonymousFunctionExpressionSyntax);
        result.Instance ??= positional.FirstOrDefault(IsValue);
        return result;
    }

    /// <summary>The lifetime a ServiceLifetime argument names; null when it is not a plain ServiceLifetime.X.</summary>
    private static string? LifetimeOf(ExpressionSyntax? expression, SemanticModel model)
    {
        if (expression == null) return null;
        var member = expression is MemberAccessExpressionSyntax access ? access.Name.Identifier.ValueText : null;
        var constant = model.GetConstantValue(expression);
        if (member is not ("Singleton" or "Scoped" or "Transient") && constant is { HasValue: true, Value: int value })
        {
            member = value switch { 0 => "Singleton", 1 => "Scoped", 2 => "Transient", _ => null }; // ServiceLifetime's values
        }

        return member switch
        {
            "Singleton" => Singleton,
            "Scoped" => Scoped,
            "Transient" => Transient,
            _ => null,
        };
    }

    /// <summary>
    /// A service key as text, the same for the registration and for [FromKeyedServices]: a string as itself,
    /// an enum member as Type.Member, other constants by value, anything else as written. Null is no key.
    /// </summary>
    private static string? KeyOf(ExpressionSyntax expression, SemanticModel model)
    {
        var constant = model.GetConstantValue(expression);
        return constant.HasValue ? KeyText(constant.Value, model.GetTypeInfo(expression).Type) : expression.ToString();
    }

    /// <summary>The key of a <c>[FromKeyedServices(key)]</c> parameter; null for none.</summary>
    public static string? KeyOf(IParameterSymbol parameter)
    {
        var attribute = parameter.GetAttributes().FirstOrDefault(a => a.AttributeClass is { Name: "FromKeyedServicesAttribute" } type
            && type.ContainingNamespace?.ToDisplayString() == "Microsoft.Extensions.DependencyInjection");
        if (attribute == null || attribute.ConstructorArguments.Length == 0) return null;
        var argument = attribute.ConstructorArguments[0];
        return argument.Kind == TypedConstantKind.Array ? null : KeyText(argument.Value, argument.Type);
    }

    private static string? KeyText(object? value, ITypeSymbol? type)
    {
        if (value == null) return null;
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Enum } enumType)
        {
            var member = enumType.GetMembers().OfType<IFieldSymbol>().FirstOrDefault(f => f.HasConstantValue && Equals(f.ConstantValue, value));
            if (member != null) return enumType.Name + "." + member.Name;
        }

        return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>sp => new X(...) is a factory for X; sp => sp.GetRequiredService&lt;X&gt;() forwards to X's registration.</summary>
    private static (ITypeSymbol? Implementation, string Kind) AnalyzeFactory(AnonymousFunctionExpressionSyntax lambda, SemanticModel model)
    {
        var body = lambda.ExpressionBody
                   ?? lambda.Block?.DescendantNodes().OfType<ReturnStatementSyntax>().FirstOrDefault()?.Expression;
        while (body is ParenthesizedExpressionSyntax or CastExpressionSyntax)
        {
            body = body is ParenthesizedExpressionSyntax p ? p.Expression : ((CastExpressionSyntax)body).Expression;
        }

        switch (body)
        {
            case BaseObjectCreationExpressionSyntax creation:
                return (model.GetTypeInfo(creation).Type, "factory");
            case InvocationExpressionSyntax invocation:
                var name = invocation.Expression switch
                {
                    MemberAccessExpressionSyntax access => access.Name,
                    SimpleNameSyntax simple => simple,
                    _ => null,
                };
                if (name is GenericNameSyntax generic
                    && generic.Identifier.ValueText is "GetRequiredService" or "GetService" or "GetRequiredKeyedService" or "GetKeyedService")
                {
                    return (model.GetTypeInfo(generic.TypeArgumentList.Arguments[0]).Type, "forward");
                }

                return (null, "factory");
            default:
                return (null, "factory");
        }
    }

    public static int Rank(string? lifetime) => lifetime switch
    {
        Singleton => 3,
        Scoped => 2,
        Transient => 1,
        _ => 0,
    };
}
