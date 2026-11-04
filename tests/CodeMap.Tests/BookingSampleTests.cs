using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>
/// samples/Booking: a room booking app with a C# API (server/) and a TypeScript client and BFF (client/), written to
/// use every edge case the reviews of C# and TypeScript mapping fixed. Each test below is one row of the table in
/// samples/Booking/README.md; the whole map is also kept as a golden file (GoldenTests).
/// </summary>
public class BookingSampleTests
{
    private const string Domain = "Booking.Domain.", Infra = "Booking.Infrastructure.";
    private const string Bff = "ts:@booking/bff:src/", Web = "ts:@booking/web:src/", Core = "ts:@booking/core:src/";
    private static readonly AnalyzerOptions NoGit = new() { Git = false };
    private static readonly Lazy<CodeGraph> Map = new(() => Analyze(Booking));

    internal static string Booking => Path.Combine(GoldenTests.RepoRoot(), "samples", "Booking");
    internal static LanguageRegistry Registry => LanguageRegistry.WithPlugins(new[] { Path.Combine(GoldenTests.RepoRoot(), "analyzers") });

    private static CodeGraph Analyze(string path) => CodeMapAnalyzer.Analyze(path, Registry, NoGit);

    private static CodeGraph Graph => Map.Value;

    private static GraphNode Node(string id) => Graph.Nodes.SingleOrDefault(n => n.Id == id) ?? throw new Xunit.Sdk.XunitException($"no node {id}");

    [NodeFact(typescript: true)]
    public void One_map_of_both_languages_without_warnings()
    {
        Assert.Equal(new[] { "csharp", "typescript" }, Graph.Source.Languages!.Select(l => l.Id));
        Assert.Empty(Graph.Analysis.Warnings);
        Assert.Equal(
            new[] { "project:Booking.Api", "project:Booking.Contracts", "project:Booking.Domain", "project:Booking.Infrastructure", "ts:project:@booking/bff", "ts:project:@booking/core", "ts:project:@booking/web" },
            Graph.Nodes.Where(n => n.Kind == NodeKinds.Project).Select(n => n.Id).Order(StringComparer.Ordinal));
    }

    [NodeFact(typescript: true)]
    public void Csharp_settings_come_from_imported_props_and_directory_build_targets()
    {
        // server/Directory.Build.props imports build/Common.props (framework, implicit usings); Directory.Build.targets adds
        // a global using for every project but Contracts. Reservation.cs relies on both: Entity<> and Guid resolve.
        var domain = Loading.ProjectLoader.ReadProject(Path.Combine(Booking, "server", "src", "Booking.Domain", "Booking.Domain.csproj"));
        Assert.Equal(("net8.0", true), (domain.TargetFramework, domain.ImplicitUsings));
        Assert.Contains("Booking.Domain.Common", domain.Usings);
        Assert.DoesNotContain("Booking.Domain.Common", Loading.ProjectLoader.ReadProject(Path.Combine(Booking, "server", "src", "Booking.Contracts", "Booking.Contracts.csproj")).Usings);
        Graph.AssertEdge($"T:{Domain}Reservations.Reservation", EdgeKinds.Inherits, $"T:{Domain}Common.Entity`1");
        Graph.AssertEdge($"T:{Domain}Reservations.ReservationValidator", EdgeKinds.Inherits, $"T:{Domain}Common.Validator`1");
    }

    [NodeFact(typescript: true)]
    public void Csharp_edges_generic_bases_property_patterns_and_nameof()
    {
        // The generic arguments of base types are dependencies.
        Graph.AssertEdge($"T:{Domain}Reservations.Reservation", EdgeKinds.Uses, $"T:{Domain}Reservations.ReservationId");
        Graph.AssertEdge($"T:{Domain}Reservations.IReservationRepository", EdgeKinds.Uses, $"T:{Domain}Reservations.Reservation");
        Graph.AssertEdge($"T:{Domain}Reservations.ReservationValidator", EdgeKinds.Uses, $"T:{Domain}Reservations.Reservation");

        // `is { Status: …, Nights: > 0 }` reads both properties.
        const string canCancel = "M:Booking.Domain.Reservations.ReservationRules.CanCancel(Booking.Domain.Reservations.Reservation)";
        Graph.AssertEdge(canCancel, EdgeKinds.Accesses, $"P:{Domain}Reservations.Reservation.Status");
        Graph.AssertEdge(canCancel, EdgeKinds.Accesses, $"P:{Domain}Reservations.Reservation.Nights");

        // nameof(Reservation.Cancel) names the method without calling it.
        const string require = "M:Booking.Domain.Reservations.ReservationRules.RequireForCancel(Booking.Domain.Reservations.Reservation)";
        Graph.AssertNoEdge(require, EdgeKinds.Calls, $"M:{Domain}Reservations.Reservation.Cancel");
        Assert.Contains(Graph.Edges, e => e.Source == require && e.Kind == EdgeKinds.Calls && e.Target.Contains("Guard.NotNull", StringComparison.Ordinal));
    }

    [NodeFact(typescript: true)]
    public void Csharp_sources_sdk_symbols_and_compile_items_as_msbuild_reads_them()
    {
        // #if NETCOREAPP2_1_OR_GREATER is defined for net8.0: that overload is on the map, the #else one is not.
        Node("M:Booking.Domain.Time.Calendar.ParseDay(System.ReadOnlySpan{System.Char})");
        Assert.DoesNotContain(Graph.Nodes, n => n.Id == "M:Booking.Domain.Time.Calendar.ParseDay(System.String)");

        // Booking.Infrastructure.csproj: Remove Legacy/** then Include one file again; conditions on the framework.
        Node($"T:{Infra}Legacy.RoomImporter");
        Node($"T:{Infra}Compat.LegacyClockAdapter");
        Assert.DoesNotContain(Graph.Nodes, n => n.Id == $"T:{Infra}Legacy.OldBilling");
        Assert.DoesNotContain(Graph.Nodes, n => n.Id == $"T:{Infra}Experimental.QuantumScheduler");

        // Booking.Contracts.csproj: EnableDefaultItems=false, only Dto/** is compiled.
        Node("T:Booking.Contracts.Dto.ReservationDto");
        Assert.DoesNotContain(Graph.Nodes, n => n.Id == "T:Booking.Contracts.Drafts.DraftContract");
    }

    [NodeFact(typescript: true)]
    public void Csharp_roles_need_evidence_and_explicit_implementations_are_used()
    {
        // RetryController is a plain class: no controller tag, not built by the container (its RetryPolicy is no issue).
        Assert.DoesNotContain(Tags.Controller, Node($"T:{Infra}Resilience.RetryController").Tags ?? new List<string>());
        Assert.Contains(Tags.Controller, Node("T:Booking.Api.Controllers.ReservationsController").Tags!);
        // ReservationBook's explicit IEnumerable.GetEnumerator and IDisposable.Dispose are called through the interfaces.
        Assert.DoesNotContain(Graph.Analysis.UnusedCandidates, id => id.StartsWith($"M:{Infra}Collections.ReservationBook", StringComparison.Ordinal));
    }

    [NodeFact(typescript: true)]
    public void Csharp_registrations_are_read_as_the_container_reads_them()
    {
        var registrations = Graph.Analysis.Di!.Registrations;
        const string clock = $"T:{Domain}Time.IClock";

        // TryAdd of FixedClock after SystemClock is ignored; the override in Program.cs comes last (AddBooking() is
        // called on the line before it, from a file that sorts first), so it wins.
        Assert.Equal(new[] { $"T:{Infra}Time.SystemClock", $"T:{Infra}Time.UtcClock" },
            registrations.Where(r => r.Service == clock && r.Key == null).Select(r => r.Implementation));

        Assert.Contains(registrations, r => r is { Service: clock, Key: "utc", Implementation: $"T:{Infra}Time.UtcClock", Kind: "type" }); // keyed Type overload
        Assert.Contains(registrations, r => r is { Key: "CacheKind.Redis", Implementation: $"T:{Infra}Caching.RedisCache" });              // enum key
        Assert.Contains(registrations, r => r is { Key: "memory", Implementation: $"T:{Infra}Caching.MemoryCache", Kind: "instance" });    // keyed instance
        Assert.Contains(registrations, r => r is { Service: $"T:{Infra}Notifications.INotifier", Implementation: $"T:{Infra}Notifications.EmailNotifier", Kind: "instance" });

        // The fluent chain: each registration on the line of its method name.
        var lines = File.ReadAllLines(Path.Combine(Booking, "server", "src", "Booking.Infrastructure", "ServiceCollectionExtensions.cs"));
        foreach (var service in new[] { "ReservationService", "AvailabilityService", "PricingService" })
        {
            var line = Array.FindIndex(lines, l => l.Contains($".AddScoped<{service}>()", StringComparison.Ordinal)) + 1;
            Assert.Equal(line, registrations.Single(r => r.Service == $"T:{Infra}Services.{service}").Location!.Line);
        }
    }

    [NodeFact(typescript: true)]
    public void Csharp_keyed_dependencies_match_their_key_and_the_override_wins()
    {
        var di = Graph.Analysis.Di!;
        DiDependency Dependency(string consumer, string service) => di.Dependencies.Single(d => d.Consumer == $"T:{Infra}Services.{consumer}" && d.Service == service);
        const string clock = $"T:{Domain}Time.IClock", cache = $"T:{Infra}Caching.ICache";

        Assert.Equal("utc", Dependency("ReservationService", clock).Key);
        Assert.Equal(new[] { $"T:{Infra}Time.UtcClock" }, Dependency("ReservationService", clock).Implementations);
        Assert.Equal(new[] { $"T:{Infra}Caching.RedisCache" }, Dependency("ReservationService", cache).Implementations);
        Assert.Equal(new[] { $"T:{Infra}Time.UtcClock" }, Dependency("PricingService", clock).Implementations);

        // An unkeyed ICache: only keyed registrations exist, so nothing is injected and the map says how to ask for one.
        Assert.Empty(Dependency("AvailabilityService", cache).Implementations);
        var issue = Assert.Single(di.Issues);
        Assert.Equal(("unregistered", $"T:{Infra}Services.AvailabilityService", cache), (issue.Kind, issue.Consumer, issue.Service));
        Assert.Contains("[FromKeyedServices]", issue.Message);
    }

    [NodeFact(typescript: true)]
    public void Typescript_references_overloads_and_signatures()
    {
        foreach (var handler in new[] { "list", "create", "cancel" }) Graph.AssertEdge(Bff + "routes.ts#handlers", EdgeKinds.Calls, Bff + "routes.ts#" + handler); // { list, create, cancel }
        Graph.AssertEdge(Bff + "reservations-api.ts#ReservationsApi.constructor", EdgeKinds.Calls, Core + "http-client.ts#HttpClient.constructor"); // super(), a package analyzed later
        Assert.Equal(5, Node(Core + "money.ts#formatMoney").Metric("loc")); // the implementation of the overloads
        Assert.Equal("export class ReservationList extends HttpClient", Node(Web + "reservation-list.ts#ReservationList").Signature);
    }

    [NodeFact(typescript: true)]
    public void Typescript_express_routes_and_their_complexity()
    {
        // A chain of verbs on a router mounted at /api, and a route on an app typed express.Express.
        var routes = Graph.Nodes.Where(n => n.Tags?.Contains("route") == true && n.Id.StartsWith("ts:", StringComparison.Ordinal)).ToList();
        Assert.Equal(new[] { "DELETE /api/reservations", "GET /api/reservations", "GET /health", "POST /api/reservations" }, routes.Select(n => n.Name).Order(StringComparer.Ordinal));
        var lines = File.ReadAllLines(Path.Combine(Booking, "client", "apps", "bff", "src", "routes.ts"));
        foreach (var verb in new[] { "get", "post", "delete" })
        {
            var route = routes.Single(n => n.Name == $"{verb.ToUpperInvariant()} /api/reservations");
            Assert.Equal(Array.FindIndex(lines, l => l.TrimStart().StartsWith($".{verb}(", StringComparison.Ordinal)) + 1, route.Location!.Line);
        }

        // The handler's decisions belong to the route: taken from register(), which registers it, not from the file's top-level code.
        Assert.Equal(3, Node(Bff + "register.ts#route:GET /health").Metric("complexity"));
        Assert.Equal(1, Node(Bff + "register.ts#register").Metric("complexity"));
        Assert.Equal(3, Node(Bff + "register.ts#(top-level)").Metric("complexity"));
    }

    [NodeFact(typescript: true)]
    public void Typescript_path_aliases_are_local_code()
    {
        Graph.AssertEdge(Web + "reservation-list.ts", EdgeKinds.Imports, Web + "util/dates.ts"); // tsconfig paths: @/*
        // Only the packages the code really uses: no `@` from `@/…`, no `~` from the Vite-only `~/…`.
        Assert.Equal(new[] { "ts:npm:@types/express", "ts:npm:express", "ts:npm:vite" },
            Graph.Nodes.Where(n => n.Kind == NodeKinds.Package).Select(n => n.Id).Order(StringComparer.Ordinal));
        // Known limit: a Vite-only alias cannot be followed, so the file it imports looks unused.
        Assert.Equal(new[] { Web + "app.config.ts" }, Graph.Analysis.UnusedCandidates);
    }

    [NodeFact(typescript: true)]
    public void A_folder_inside_a_project_maps_with_that_project()
    {
        var web = Analyze(Path.Combine(Booking, "client", "apps", "web", "src"));
        Assert.Equal("ts:project:@booking/web", Assert.Single(web.Nodes, n => n.Kind == NodeKinds.Project).Id);
        Assert.Contains(web.Nodes, n => n.Id == Web + "reservation-list.ts#ReservationList");
        Assert.Empty(web.Analysis.Warnings);

        var api = Analyze(Path.Combine(Booking, "server", "src", "Booking.Api"));
        Assert.Contains(api.Nodes, n => n.Id == "project:Booking.Api");
        Assert.Contains(api.Nodes, n => n.Id == "T:Booking.Api.Controllers.ReservationsController");
    }
}
