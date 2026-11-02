using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>
/// Rebuilds what the DI container will do: which implementation each constructor receives and with
/// which lifetime. Flags captive dependencies (a singleton holding a scoped/transient service) and
/// services that nothing registers.
/// </summary>
internal static class DependencyInjectionAnalysis
{
    private const string Singleton = DiRegistrationDetector.Singleton;
    private const string Scoped = DiRegistrationDetector.Scoped;
    private const string Transient = DiRegistrationDetector.Transient;

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

    private sealed record Registration(ServiceRegistration Public, string Ident);

    /// <summary>
    /// Works from what the language put in <c>analysis.di</c> (registrations, and the services every type's
    /// constructor asks for) and replaces it with the result: who gets what with which lifetime, and the issues.
    /// </summary>
    public static void Compute(CodeGraph graph)
    {
        var setup = graph.Analysis.Di;
        graph.Analysis.Di = null;
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);

        static string Ident(string service, bool external) => external ? "ext:" + service : service;

        var registrations = (setup?.Registrations ?? new List<ServiceRegistration>())
            .Select(r => new Registration(r, Ident(r.Service, r.External)))
            .ToList();

        // Who gets constructed by the container, and for how long it lives.
        var consumers = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var registration in registrations)
        {
            // Instances and factories are built by user code; forwards resolve through another registration.
            if (registration.Public.Kind is "instance" or "factory" or "forward") continue;
            var implementation = registration.Public.Implementation ?? (registration.Public.External ? null : registration.Public.Service);
            if (implementation != null) consumers.TryAdd(implementation, registration.Public.Lifetime);
        }

        // Types the framework activates without a registration.
        foreach (var node in graph.Nodes.Where(n => NodeLevels.IsType(n) && !n.External && n.Modifiers?.Contains("abstract") != true))
        {
            if (consumers.ContainsKey(node.Id)) continue;
            if (node.HasTag(Tags.Controller) || node.HasTag(Tags.Hub)) consumers[node.Id] = Transient; // one per request
            else if (node.HasTag(Tags.Middleware)) consumers[node.Id] = Singleton; // convention middleware is created once
        }

        if (registrations.Count == 0 && consumers.Count == 0) return;

        var byService = registrations.GroupBy(r => r.Ident).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var dependenciesById = (setup?.Dependencies ?? new List<DiDependency>())
            .GroupBy(d => d.Consumer, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        var di = new DiAnalysis { Registrations = registrations.Select(r => r.Public).ToList() };
        string Name(string id) => byId.TryGetValue(id, out var n) ? n.Name : id.Split('.', ':').Last();

        foreach (var (consumer, lifetime) in consumers.OrderBy(c => c.Key, StringComparer.Ordinal))
        {
            if (!dependenciesById.TryGetValue(consumer, out var dependencies)) continue;
            foreach (var dependency in dependencies)
            {
                var external = dependency.External;
                var serviceName = dependency.Service;
                var ident = Ident(serviceName, external);
                var result = new DiDependency
                {
                    Consumer = consumer,
                    ConsumerLifetime = lifetime,
                    Service = serviceName,
                    External = external,
                    Many = dependency.Many,
                    Optional = dependency.Optional,
                };

                var lifetimes = new List<string>();
                if (byService.TryGetValue(ident, out var candidates))
                {
                    var selected = dependency.Many ? candidates : new List<Registration> { candidates[^1] }; // the last registration wins
                    result.Implementations = selected
                        .Select(r => r.Public.Implementation ?? (r.Public.External ? null : r.Public.Service))
                        .Where(i => i != null)
                        .Select(i => i!)
                        .Distinct(StringComparer.Ordinal)
                        .ToList();
                    lifetimes.AddRange(selected.Select(r => r.Public.Lifetime).Distinct());
                }
                else if (external)
                {
                    if (FrameworkLifetimes.TryGetValue(serviceName, out var known)) lifetimes.Add(known);
                }
                else if (!dependency.Optional && !dependency.Many)
                {
                    di.Issues.Add(new DiIssue
                    {
                        Kind = "unregistered",
                        Severity = "warning",
                        Consumer = consumer,
                        Service = serviceName,
                        Message = $"{Name(consumer)} needs {Name(serviceName)}, but no registration for it was found in the analyzed code.",
                    });
                }

                result.Lifetime = lifetimes.Count == 1 ? lifetimes[0] : lifetimes.Count > 1 ? "mixed" : null;
                di.Dependencies.Add(result);

                if (lifetime != Singleton) continue;
                var shortName = external ? serviceName.Split('<')[0].Split('.').Last() : Name(serviceName);
                if (lifetimes.Contains(Scoped))
                {
                    di.Issues.Add(new DiIssue
                    {
                        Kind = "captive",
                        Severity = "error",
                        Consumer = consumer,
                        Service = serviceName,
                        Message = $"{Name(consumer)} lives as a singleton but depends on scoped {shortName}: one instance gets shared by every request and outlives its scope.",
                    });
                }
                else if (lifetimes.Contains(Transient) && !external)
                {
                    di.Issues.Add(new DiIssue
                    {
                        Kind = "captive-transient",
                        Severity = "warning",
                        Consumer = consumer,
                        Service = serviceName,
                        Message = $"{Name(consumer)} is a singleton, so the transient {shortName} it receives lives for the whole application.",
                    });
                }
            }
        }

        // Make lifetimes visible on the map.
        foreach (var registration in registrations)
        {
            foreach (var id in new[] { registration.Public.Implementation, registration.Public.External ? null : registration.Public.Service })
            {
                if (id != null && byId.TryGetValue(id, out var node)) node.AddTag(registration.Public.Lifetime);
            }
        }

        foreach (var issue in di.Issues)
        {
            if (byId.TryGetValue(issue.Consumer, out var node)) node.AddTag(Tags.DiIssue);
        }

        di.Issues = di.Issues
            .DistinctBy(i => (i.Kind, i.Consumer, i.Service))
            .OrderBy(i => i.Severity == "error" ? 0 : 1)
            .ThenBy(i => i.Consumer, StringComparer.Ordinal)
            .ToList();
        graph.Analysis.Di = di;
    }
}
