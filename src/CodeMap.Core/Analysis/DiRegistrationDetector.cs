using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMap.Analysis;

/// <summary>A service registration recognised in code, still in Roslyn terms.</summary>
internal sealed record RegistrationCandidate(
    ITypeSymbol? Service,
    string? ServiceName,
    ITypeSymbol? Implementation,
    string Lifetime,
    string Kind,
    string? Key);

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

    public static RegistrationCandidate? TryDetect(InvocationExpressionSyntax node, SemanticModel model)
    {
        var name = node.Expression switch
        {
            MemberAccessExpressionSyntax access => access.Name,
            SimpleNameSyntax simple => simple,
            MemberBindingExpressionSyntax binding => binding.Name,
            _ => null,
        };
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

        var info = model.GetSymbolInfo(node);
        var method = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
        var arguments = node.ArgumentList.Arguments.Select(a => a.Expression).ToList();

        List<ITypeSymbol?> typeArguments;
        if (method != null)
        {
            var definition = method.ReducedFrom ?? method;
            var ns = definition.ContainingNamespace?.ToDisplayString() ?? "";
            var trusted = ns.StartsWith("Microsoft.Extensions.DependencyInjection", StringComparison.Ordinal)
                          || (kind == "dbcontext" && ns.StartsWith("Microsoft.", StringComparison.Ordinal));
            if (!trusted) return null;
            typeArguments = method.TypeArguments.Cast<ITypeSymbol?>().ToList();
            // Static call form ServiceCollectionServiceExtensions.AddX(services, ...): drop the collection argument.
            if (method.ReducedFrom == null && method.IsExtensionMethod && arguments.Count > 0) arguments.RemoveAt(0);
        }
        else
        {
            // Not resolved (e.g. the DI package was never restored): trust the name, but require type information.
            typeArguments = name is GenericNameSyntax generic
                ? generic.TypeArgumentList.Arguments.Select(t => model.GetTypeInfo(t).Type).ToList()
                : new List<ITypeSymbol?>();
            if (typeArguments.Count == 0 && !arguments.Any(a => a is TypeOfExpressionSyntax) && arguments.Count != 1) return null;
        }

        string? key = null;
        if (methodName.Contains("Keyed", StringComparison.Ordinal) && arguments.Count > 0)
        {
            var constant = model.GetConstantValue(arguments[0]);
            key = constant.HasValue ? constant.Value?.ToString() : arguments[0].ToString();
            arguments.RemoveAt(0);
        }

        switch (kind)
        {
            case "hosted":
                return typeArguments.Count > 0
                    ? new RegistrationCandidate(null, "Microsoft.Extensions.Hosting.IHostedService", typeArguments[0], lifetime, kind, key)
                    : null;
            case "dbcontext":
            case "httpclient":
                if (typeArguments.Count == 0) return null; // AddHttpClient("name") registers no type of ours
                return new RegistrationCandidate(typeArguments[0], null, typeArguments.Count > 1 ? typeArguments[1] : typeArguments[0], lifetime, kind, key);
        }

        var typeOfs = arguments.OfType<TypeOfExpressionSyntax>().Select(t => model.GetTypeInfo(t.Type).Type).ToList();
        var factory = arguments.FirstOrDefault(a => a is AnonymousFunctionExpressionSyntax) as AnonymousFunctionExpressionSyntax;

        // AddX<IService, Impl>(sp => ...) : the lambda builds Impl, the container does not call its constructor.
        if (typeArguments.Count >= 2) return new RegistrationCandidate(typeArguments[0], null, typeArguments[1], lifetime, factory != null ? "factory" : "type", key);
        var instance = arguments.FirstOrDefault(a => a is not (TypeOfExpressionSyntax or AnonymousFunctionExpressionSyntax));

        var service = typeArguments.Count == 1 ? typeArguments[0] : typeOfs.FirstOrDefault();
        if (factory != null)
        {
            var (implementation, factoryKind) = AnalyzeFactory(factory, model);
            service ??= implementation;
            return service == null ? null : new RegistrationCandidate(service, null, implementation, lifetime, factoryKind, key);
        }

        if (typeOfs.Count >= 2) return new RegistrationCandidate(typeOfs[0], null, typeOfs[1], lifetime, "type", key);

        if (instance != null && typeOfs.Count == 0)
        {
            var instanceType = model.GetTypeInfo(instance).Type;
            if (instanceType == null || instanceType.TypeKind == TypeKind.Error) return service == null ? null : new RegistrationCandidate(service, null, service, lifetime, "instance", key);
            return new RegistrationCandidate(service ?? instanceType, null, instanceType, lifetime, "instance", key);
        }

        return service == null ? null : new RegistrationCandidate(service, null, service, lifetime, "type", key);
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
