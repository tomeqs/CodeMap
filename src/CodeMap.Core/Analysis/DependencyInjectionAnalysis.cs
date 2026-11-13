using CodeMap.Model;

namespace CodeMap.Analysis;

/// <summary>
/// Rebuilds what the DI container will do: which implementation each constructor receives and with
/// which lifetime. Flags services that nothing registers and what the container's rules make of the
/// lifetimes: captive dependencies in .NET (a singleton holding a scoped/transient service), request scope
/// spreading to its consumers in NestJS, root services that cannot reach component providers in Angular.
/// Each registration says which container it belongs to (<see cref="ServiceRegistration.Framework"/>).
/// </summary>
internal static class DependencyInjectionAnalysis
{
    private const string Singleton = DiRegistrationDetector.Singleton;
    private const string Scoped = DiRegistrationDetector.Scoped;

    private sealed record Registration(ServiceRegistration Public, string Ident);

    /// <summary>The namespace and containing types in a type's full name (<c>Shop.</c> in <c>Shop.Kind</c>).</summary>
    private static readonly System.Text.RegularExpressions.Regex QualifiedPrefix = new(@"\b\w+\.", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// Works from what the languages put in <c>analysis.di</c> (registrations, and the services every type's
    /// constructor asks for) and replaces it with the result: who gets what with which lifetime, and the issues.
    /// </summary>
    /// <param name="languageOf">Language of a node (by its project), so framework conventions apply to their language only.</param>
    public static void Compute(CodeGraph graph, Func<GraphNode, string?>? languageOf = null)
    {
        var setup = graph.Analysis.Di;
        graph.Analysis.Di = null;
        languageOf ??= _ => null;
        var byId = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        var registrations = setup?.Registrations ?? new List<ServiceRegistration>();
        var dependencies = setup?.Dependencies ?? new List<DiDependency>();

        // Raw dependencies may leave their container out: the consumer's registration knows it.
        var containerOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var r in registrations)
        {
            var id = r.Implementation ?? (r.External ? null : r.Service);
            if (id != null) containerOf.TryAdd(id, r.Framework ?? DiRules.Microsoft);
        }

        string FrameworkOf(DiDependency d) => d.Framework ?? containerOf.GetValueOrDefault(d.Consumer) ?? DiRules.Microsoft;
        var frameworks = registrations.Select(r => r.Framework ?? DiRules.Microsoft)
            .Concat(dependencies.Select(FrameworkOf))
            .Append(DiRules.Microsoft)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(f => f == DiRules.Microsoft ? 0 : 1)
            .ThenBy(f => f, StringComparer.Ordinal)
            .ToList();

        var di = new DiAnalysis();
        var found = false;
        foreach (var framework in frameworks)
        {
            var rules = DiRules.For(framework);
            found |= ComputeContainer(graph, byId, rules,
                registrations.Where(r => (r.Framework ?? DiRules.Microsoft) == framework).ToList(),
                dependencies.Where(d => FrameworkOf(d) == framework).ToList(),
                languageOf, di);
        }

        if (!found) return;

        foreach (var issue in di.Issues)
        {
            if (byId.TryGetValue(issue.Consumer, out var node)) node.AddTag(Tags.DiIssue);
        }

        di.Issues = di.Issues
            .DistinctBy(i => (i.Kind, i.Consumer, i.Service))
            .OrderBy(i => i.Severity switch { "error" => 0, "warning" => 1, _ => 2 })
            .ThenBy(i => i.Consumer, StringComparer.Ordinal)
            .ToList();
        graph.Analysis.Di = di;
    }

    /// <summary>One container's registrations and dependencies; false when it has nothing to say.</summary>
    private static bool ComputeContainer(CodeGraph graph, Dictionary<string, GraphNode> byId, DiRules rules,
        List<ServiceRegistration> rawRegistrations, List<DiDependency> rawDependencies, Func<GraphNode, string?> languageOf, DiAnalysis di)
    {
        static string Ident(string service, bool external) => external ? "ext:" + service : service;
        string Name(string id) => byId.TryGetValue(id, out var n) ? n.Name : id.Split('.', ':').Last();

        var registrations = rawRegistrations.Select(r => new Registration(r, Ident(r.Service, r.External))).ToList();

        // Who gets constructed by the container, and for how long it lives.
        var consumers = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var registration in registrations)
        {
            // Instances and factories are built by user code (unless the container calls them); forwards resolve through another registration.
            if (!rules.Constructs(registration.Public)) continue;
            var implementation = registration.Public.Implementation ?? (registration.Public.External ? null : registration.Public.Service);
            // A class registered more than once is checked as the longest-lived of its registrations: a singleton
            // must not hold what lives shorter, whatever else the class is registered as.
            if (implementation != null && (!consumers.TryGetValue(implementation, out var known) || Longer(registration.Public.Lifetime, known)))
                consumers[implementation] = registration.Public.Lifetime;
        }

        // Types the framework activates without a registration.
        foreach (var (id, lifetime) in rules.ImplicitConsumers(graph, languageOf))
        {
            consumers.TryAdd(id, lifetime);
        }

        if (registrations.Count == 0 && consumers.Count == 0) return false;

        // A keyed registration only serves requests for its key ([FromKeyedServices]), an unkeyed one only plain requests.
        var byService = registrations.GroupBy(r => (r.Ident, r.Public.Key)).ToDictionary(g => g.Key, g => g.ToList());
        var dependenciesById = rawDependencies
            .GroupBy(d => d.Consumer, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        List<Registration>? Selected(DiDependency dependency)
        {
            if (!byService.TryGetValue((Ident(dependency.Service, dependency.External), dependency.Key), out var candidates)) return null;
            if (dependency.TypeArguments is { } arguments)
            {
                // ILookup<Kind>: registrations of ILookup<Kind>, else the open generic ones (typeof(ILookup<>)); never ILookup<Brand>.
                bool Same(Registration r) => r.Public.TypeArguments is { } own && own.SequenceEqual(arguments, StringComparer.Ordinal);
                var exact = candidates.Where(Same).ToList();
                var open = candidates.Where(r => r.Public.TypeArguments == null).ToList();
                candidates = dependency.Many ? candidates.Where(r => Same(r) || r.Public.TypeArguments == null).ToList()
                    : exact.Count > 0 ? exact : open;
                if (candidates.Count == 0) return null;
            }

            return dependency.Many ? candidates : new List<Registration> { candidates[^1] }; // the last registration wins
        }

        string Unregistered(DiDependency dependency)
        {
            var ident = Ident(dependency.Service, dependency.External);
            if (dependency.Key != null)
                return $"{Name(dependency.Consumer)} needs {Name(dependency.Service)} under the key \"{dependency.Key}\", but no registration with that key was found in the analyzed code.";
            if (dependency.TypeArguments is { } arguments && byService.TryGetValue((ident, null), out var others))
            {
                string Closed(IEnumerable<string> types) => $"{Name(dependency.Service).Split('<')[0]}<{string.Join(", ", types.Select(t => QualifiedPrefix.Replace(t, "")))}>";
                var registered = others.Where(r => r.Public.TypeArguments != null).Select(r => Closed(r.Public.TypeArguments!)).Distinct().ToList();
                if (registered.Count > 0) return $"{Name(dependency.Consumer)} needs {Closed(arguments)}, but it is only registered as {string.Join(", ", registered)}.";
            }

            var keys = byService.Keys.Where(k => k.Ident == ident && k.Key != null).Select(k => $"\"{k.Key}\"").Distinct().ToList();
            return keys.Count == 0 ? ""
                : $"{Name(dependency.Consumer)} needs {Name(dependency.Service)}, but it is only registered under a key ({string.Join(", ", keys)}): ask for it with [FromKeyedServices].";
        }

        static string? ImplementationOf(Registration r) => r.Public.Implementation ?? (r.Public.External ? null : r.Public.Service);

        static bool Longer(string lifetime, string than)
        {
            static int Rank(string l) => l switch { DiRegistrationDetector.Singleton => 3, DiRegistrationDetector.Scoped => 2, DiRegistrationDetector.Transient => 1, _ => 0 };
            return Rank(lifetime) > Rank(than);
        }

        // The container's own rules may change lifetimes (NestJS: request scope spreads to consumers).
        var effective = new Dictionary<string, string>(consumers, StringComparer.Ordinal);
        var wiring = consumers.Keys
            .Select(consumer => (consumer, (IReadOnlyList<string>)(dependenciesById.GetValueOrDefault(consumer) ?? new List<DiDependency>())
                .SelectMany(d => Selected(d) ?? new List<Registration>())
                .Select(ImplementationOf)
                .Where(i => i != null)
                .Select(i => i!)
                .ToList()))
            .ToList();
        rules.Adjust(effective, wiring, di.Issues, Name);

        // A registration lives as long as it says (the last one of a service is the one injected, with its own
        // lifetime). Two things say otherwise: the container's rules changed the class' lifetime (NestJS: request
        // scope spreads), and a registration that only forwards to another one lives as long as that one.
        string LifetimeOf(Registration r)
        {
            if (ImplementationOf(r) is not { } id || !effective.TryGetValue(id, out var lifetime)) return r.Public.Lifetime;
            var changedByRules = !consumers.TryGetValue(id, out var declared) || declared != lifetime;
            return changedByRules || r.Public.Kind == "forward" ? lifetime : r.Public.Lifetime;
        }

        di.Registrations.AddRange(registrations.Select(r => r.Public));

        foreach (var (consumer, _) in consumers.OrderBy(c => c.Key, StringComparer.Ordinal))
        {
            var lifetime = effective[consumer];
            if (!dependenciesById.TryGetValue(consumer, out var dependencies)) continue;
            foreach (var dependency in dependencies)
            {
                var external = dependency.External;
                var serviceName = dependency.Service;
                var result = new DiDependency
                {
                    Consumer = consumer,
                    ConsumerLifetime = lifetime,
                    Service = serviceName,
                    External = external,
                    TypeArguments = dependency.TypeArguments,
                    Many = dependency.Many,
                    Optional = dependency.Optional,
                    Key = dependency.Key,
                    Framework = rules.Framework == DiRules.Microsoft ? null : rules.Framework,
                };

                var lifetimes = new List<string>();
                if (Selected(dependency) is { } selected)
                {
                    result.Implementations = selected
                        .Select(ImplementationOf)
                        .Where(i => i != null)
                        .Select(i => i!)
                        .Distinct(StringComparer.Ordinal)
                        .ToList();
                    lifetimes.AddRange(selected.Select(LifetimeOf).Distinct());
                }
                else if (external)
                {
                    if (rules.KnownLifetime(serviceName) is { } known) lifetimes.Add(known);
                }
                else if (!dependency.Optional && !dependency.Many)
                {
                    var issue = rules.Unregistered(consumer, serviceName, byId.GetValueOrDefault(serviceName), Name);
                    if (issue.Kind == "unregistered" && Unregistered(dependency) is { Length: > 0 } message) issue.Message = message;
                    di.Issues.Add(issue);
                }

                result.Lifetime = lifetimes.Count == 1 ? lifetimes[0] : lifetimes.Count > 1 ? "mixed" : null;
                di.Dependencies.Add(result);
                di.Issues.AddRange(rules.Check(consumer, lifetime, serviceName, external, lifetimes, Name));
            }
        }

        // Make lifetimes visible on the map.
        foreach (var registration in registrations)
        {
            var lifetime = LifetimeOf(registration);
            if (lifetime != registration.Public.Lifetime) registration.Public.Effective = lifetime;
            foreach (var id in new[] { registration.Public.Implementation, registration.Public.External ? null : registration.Public.Service })
            {
                if (id != null && byId.TryGetValue(id, out var node)) node.AddTag(lifetime);
            }
        }

        return true;
    }
}
