using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>What one DI container does with lifetimes, and what it considers a mistake.</summary>
internal abstract class DiRules
{
    public const string Microsoft = "microsoft";
    protected const string Singleton = DiRegistrationDetector.Singleton;
    protected const string Scoped = DiRegistrationDetector.Scoped;
    protected const string Transient = DiRegistrationDetector.Transient;

    public abstract string Framework { get; }

    public static DiRules For(string framework) => framework switch
    {
        Microsoft => new MicrosoftDiRules(),
        "nest" => new NestDiRules(),
        "angular" => new AngularDiRules(),
        _ => new GenericDiRules(framework),
    };

    /// <summary>Lifetime of a service that is not in the analyzed code, when it is known.</summary>
    public virtual string? KnownLifetime(string service) => null;

    /// <summary>Types the framework creates itself, without a registration, and their lifetime.</summary>
    public virtual IEnumerable<(string Id, string Lifetime)> ImplicitConsumers(CodeGraph graph, Func<GraphNode, string?> languageOf) =>
        Enumerable.Empty<(string, string)>();

    /// <summary>Lifetimes after the container's own rules (consumer → the implementations it receives).</summary>
    public virtual void Adjust(Dictionary<string, string> lifetimes, IReadOnlyList<(string Consumer, IReadOnlyList<string> Implementations)> wiring,
        List<DiIssue> issues, Func<string, string> name)
    {
    }

    /// <summary>Problems of one dependency of a consumer with this lifetime.</summary>
    public virtual IEnumerable<DiIssue> Check(string consumer, string consumerLifetime, string service, bool external, List<string> lifetimes, Func<string, string> name) =>
        Enumerable.Empty<DiIssue>();

    public virtual DiIssue Unregistered(string consumer, string service, GraphNode? serviceNode, Func<string, string> name) => new()
    {
        Kind = "unregistered",
        Severity = "warning",
        Consumer = consumer,
        Service = service,
        Message = $"{name(consumer)} needs {name(service)}, but no registration for it was found in the analyzed code.",
    };

    protected static string ShortName(string service, bool external, Func<string, string> name) =>
        external ? service.Split('<')[0].Split('.').Last() : name(service);
}

/// <summary>Microsoft.Extensions.DependencyInjection (.NET): captive dependencies.</summary>
internal sealed class MicrosoftDiRules : DiRules
{
    /// <summary>Lifetimes of common framework services (by type definition name).</summary>
    private static readonly Dictionary<string, string> FrameworkLifetimes = new(StringComparer.Ordinal)
    {
        ["Microsoft.Extensions.Options.IOptions<TOptions>"] = Singleton,
        ["Microsoft.Extensions.Options.IOptionsMonitor<TOptions>"] = Singleton,
        ["Microsoft.Extensions.Options.IOptionsSnapshot<TOptions>"] = Scoped,
        ["Microsoft.Extensions.Logging.ILogger<TCategoryName>"] = Singleton,
        ["Microsoft.Extensions.Logging.ILoggerFactory"] = Singleton,
        ["Microsoft.Extensions.Configuration.IConfiguration"] = Singleton,
        ["Microsoft.Extensions.Hosting.IHostEnvironment"] = Singleton,
        ["Microsoft.AspNetCore.Hosting.IWebHostEnvironment"] = Singleton,
        ["Microsoft.Extensions.Hosting.IHostApplicationLifetime"] = Singleton,
        ["System.Net.Http.IHttpClientFactory"] = Singleton,
        ["Microsoft.AspNetCore.Http.IHttpContextAccessor"] = Singleton,
        ["Microsoft.Extensions.DependencyInjection.IServiceScopeFactory"] = Singleton,
        ["System.TimeProvider"] = Singleton,
        ["Microsoft.Extensions.Caching.Memory.IMemoryCache"] = Singleton,
        ["Microsoft.Extensions.Caching.Distributed.IDistributedCache"] = Singleton,
    };

    public override string Framework => Microsoft;

    public override string? KnownLifetime(string service) => FrameworkLifetimes.GetValueOrDefault(service);

    /// <summary>
    /// ASP.NET Core creates controllers, hubs, Razor pages and Blazor components per request (or render) and convention
    /// middleware once – classes only, in C# code only.
    /// </summary>
    public override IEnumerable<(string Id, string Lifetime)> ImplicitConsumers(CodeGraph graph, Func<GraphNode, string?> languageOf)
    {
        foreach (var node in graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && n.Kind is NodeKinds.Class or NodeKinds.Record && n.Modifiers?.Contains("abstract") != true))
        {
            if (languageOf(node) is not (null or "csharp")) continue;
            if (node.HasTag(Tags.Controller) || node.HasTag(Tags.Hub) || node.HasTag(Tags.Page) || node.HasTag(Tags.Component)) yield return (node.Id, Transient); // one per request
            else if (node.HasTag(Tags.Middleware)) yield return (node.Id, Singleton); // convention middleware is created once
        }
    }

    public override IEnumerable<DiIssue> Check(string consumer, string consumerLifetime, string service, bool external, List<string> lifetimes, Func<string, string> name)
    {
        if (consumerLifetime != Singleton) yield break;
        var shortName = ShortName(service, external, name);
        if (lifetimes.Contains(Scoped))
        {
            yield return new DiIssue
            {
                Kind = "captive",
                Severity = "error",
                Consumer = consumer,
                Service = service,
                Message = $"{name(consumer)} lives as a singleton but depends on scoped {shortName}: one instance gets shared by every request and outlives its scope.",
            };
        }
        else if (lifetimes.Contains(Transient) && !external)
        {
            yield return new DiIssue
            {
                Kind = "captive-transient",
                Severity = "warning",
                Consumer = consumer,
                Service = service,
                Message = $"{name(consumer)} is a singleton, so the transient {shortName} it receives lives for the whole application.",
            };
        }
    }
}

/// <summary>
/// NestJS: providers are singletons unless REQUEST or TRANSIENT scoped. A request-scoped provider makes everything
/// that depends on it request-scoped too (the scope bubbles up); that is by design, but costs an instance per
/// request, so it is noted. Types are erased at runtime, so an interface can only be injected through a token.
/// </summary>
internal sealed class NestDiRules : DiRules
{
    private static readonly Dictionary<string, string> Known = new(StringComparer.Ordinal)
    {
        ["REQUEST"] = Scoped,
        ["INQUIRER"] = Transient,
        ["ConfigService"] = Singleton,
        ["ModuleRef"] = Singleton,
        ["Reflector"] = Singleton,
        ["HttpService"] = Singleton,
        ["JwtService"] = Singleton,
        ["EventEmitter2"] = Singleton,
        ["SchedulerRegistry"] = Singleton,
        ["DataSource"] = Singleton,
        ["EntityManager"] = Singleton,
    };

    public override string Framework => "nest";

    public override string? KnownLifetime(string service) =>
        Known.GetValueOrDefault(service) ?? (service.StartsWith("Repository<", StringComparison.Ordinal) || service.StartsWith("Model<", StringComparison.Ordinal) ? Singleton : null);

    public override void Adjust(Dictionary<string, string> lifetimes, IReadOnlyList<(string Consumer, IReadOnlyList<string> Implementations)> wiring,
        List<DiIssue> issues, Func<string, string> name)
    {
        var because = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var changed = true; changed;)
        {
            changed = false;
            foreach (var (consumer, implementations) in wiring)
            {
                if (lifetimes.GetValueOrDefault(consumer) != Singleton) continue;
                var cause = implementations.FirstOrDefault(i => lifetimes.GetValueOrDefault(i) == Scoped);
                if (cause == null) continue;
                lifetimes[consumer] = Scoped;
                because[consumer] = cause;
                changed = true;
            }
        }

        foreach (var (consumer, cause) in because)
        {
            issues.Add(new DiIssue
            {
                Kind = "scope-bubbling",
                Severity = "info",
                Consumer = consumer,
                Service = cause,
                Message = $"{name(consumer)} becomes request-scoped because it depends on request-scoped {name(cause)}: Nest creates a new {name(consumer)} for every request.",
            });
        }
    }

    public override DiIssue Unregistered(string consumer, string service, GraphNode? serviceNode, Func<string, string> name) =>
        serviceNode?.Kind == NodeKinds.Interface
            ? new DiIssue
            {
                Kind = "interface-injection",
                Severity = "warning",
                Consumer = consumer,
                Service = service,
                Message = $"{name(consumer)} asks for the interface {name(service)}, which Nest cannot inject (interfaces do not exist at runtime): provide it under a token and use @Inject(TOKEN).",
            }
            : base.Unregistered(consumer, service, serviceNode, name);
}

/// <summary>
/// Angular: services provided in root (or by an NgModule) are application singletons; providers of a component
/// live with each component instance (scoped). A root singleton cannot get a service only components provide.
/// </summary>
internal sealed class AngularDiRules : DiRules
{
    private static readonly Dictionary<string, string> Known = new(StringComparer.Ordinal)
    {
        ["HttpClient"] = Singleton,
        ["Router"] = Singleton,
        ["Title"] = Singleton,
        ["DomSanitizer"] = Singleton,
        ["NgZone"] = Singleton,
        ["ApplicationRef"] = Singleton,
        ["Injector"] = Singleton,
        ["FormBuilder"] = Singleton,
        ["ActivatedRoute"] = Scoped,
        ["ChangeDetectorRef"] = Scoped,
        ["ElementRef"] = Scoped,
        ["Renderer2"] = Scoped,
        ["ViewContainerRef"] = Scoped,
        ["DestroyRef"] = Scoped,
    };

    public override string Framework => "angular";

    public override string? KnownLifetime(string service) => Known.GetValueOrDefault(service);

    public override IEnumerable<DiIssue> Check(string consumer, string consumerLifetime, string service, bool external, List<string> lifetimes, Func<string, string> name)
    {
        if (consumerLifetime != Singleton || external || !lifetimes.Contains(Scoped) || lifetimes.Contains(Singleton)) yield break;
        yield return new DiIssue
        {
            Kind = "unreachable",
            Severity = "error",
            Consumer = consumer,
            Service = service,
            Message = $"{name(consumer)} is an application-wide service, but {name(service)} is only provided by components: the root injector cannot give it (NullInjectorError).",
        };
    }
}

/// <summary>A container CodeMap knows no rules for: wiring and missing registrations only.</summary>
internal sealed class GenericDiRules(string framework) : DiRules
{
    public override string Framework => framework;
}
