using CodeMap.Model;

namespace CodeMap.Tests;

public class DependencyInjectionTests
{
    private const string Services = """
        using Microsoft.AspNetCore.Mvc;
        using Microsoft.Extensions.DependencyInjection;
        using Microsoft.Extensions.Hosting;
        using Microsoft.Extensions.Options;

        namespace App;

        public interface IClock { }
        public class Clock : IClock { }
        public interface IRepo<T> { }
        public class Repo<T> : IRepo<T> { }
        public class Db { }
        public interface IPlugin { }
        public class P1 : IPlugin { }
        public class P2 : IPlugin { }
        public interface IMissing { }
        public class Helper { }
        public class Settings { }
        public class Built(IMissing missing) : IPlugin;

        public class Cache(Db db, IClock clock);
        public class Worker(Db db) : BackgroundService
        {
            protected override Task ExecuteAsync(CancellationToken token) => Task.CompletedTask;
        }
        public class Handler
        {
            public Handler(IRepo<string> repo, IEnumerable<IPlugin> plugins, IMissing missing, IClock clock, int retries = 3) { }
        }
        public class Notifier(Helper helper);
        public class Reporter(IOptionsSnapshot<Settings> settings);

        [ApiController]
        public class OrdersController(IMissing missing, Handler handler) : ControllerBase { }

        public static class Setup
        {
            public static IServiceCollection AddApp(this IServiceCollection services)
            {
                services.AddSingleton<IClock, Clock>();
                services.AddScoped<Db>();
                services.AddSingleton<Cache>();
                services.AddHostedService<Worker>();
                services.AddScoped(typeof(IRepo<>), typeof(Repo<>));
                services.AddTransient<IPlugin, P1>();
                services.AddTransient<IPlugin, P2>();
                services.AddTransient<Handler>();
                services.AddSingleton<Notifier>();
                services.AddTransient<Helper>();
                services.AddSingleton<Reporter>();
                services.AddSingleton(new Settings());
                services.AddKeyedSingleton<IClock, Clock>("utc");
                services.AddSingleton<IClock>(sp => sp.GetRequiredService<Clock>());
                services.AddSingleton<IPlugin, Built>(sp => new Built(null!));
                return services;
            }
        }
        """;

    [Fact]
    public void Reconstructs_registrations_lifetimes_and_flags_container_bugs()
    {
        using var ws = new TestWorkspace()
            .Project("App", sdk: "Microsoft.NET.Sdk.Web")
            .File("App/Setup.cs", Services);

        var graph = ws.Analyze();
        var di = graph.Analysis.Di;
        Assert.NotNull(di);

        ServiceRegistration Reg(string service, string? implementation = null) =>
            di!.Registrations.First(r => r.Service == service && (implementation == null || r.Implementation == implementation));

        Assert.Equal("singleton", Reg("T:App.IClock", "T:App.Clock").Lifetime);
        Assert.Equal("scoped", Reg("T:App.Db").Lifetime);
        Assert.Equal("scoped", Reg("T:App.IRepo`1").Lifetime);
        Assert.Equal("T:App.Repo`1", Reg("T:App.IRepo`1").Implementation);
        var hosted = Reg("Microsoft.Extensions.Hosting.IHostedService");
        Assert.True(hosted.External);
        Assert.Equal(("T:App.Worker", "singleton", "hosted"), (hosted.Implementation, hosted.Lifetime, hosted.Kind));
        Assert.Equal("instance", Reg("T:App.Settings").Kind);
        Assert.Equal("utc", di!.Registrations.Single(r => r.Key != null).Key);
        Assert.Contains(di.Registrations, r => r is { Service: "T:App.IClock", Kind: "forward", Implementation: "T:App.Clock" });
        Assert.Equal("M:App.Setup.AddApp(Microsoft.Extensions.DependencyInjection.IServiceCollection)", Reg("T:App.Db").RegisteredIn);

        var plugins = di.Dependencies.Single(d => d is { Consumer: "T:App.Handler", Service: "T:App.IPlugin" });
        Assert.True(plugins.Many);
        Assert.Equal(new[] { "T:App.P1", "T:App.P2", "T:App.Built" }, plugins.Implementations);
        Assert.Equal(new[] { "T:App.Repo`1" }, di.Dependencies.Single(d => d is { Consumer: "T:App.Handler", Service: "T:App.IRepo`1" }).Implementations);
        Assert.DoesNotContain(di.Dependencies, d => d.Consumer == "T:App.Handler" && d.Service.Contains("Int32"));

        void AssertIssue(string kind, string consumer, string service) =>
            Assert.Contains(di.Issues, i => i.Kind == kind && i.Consumer == consumer && i.Service == service);

        AssertIssue("captive", "T:App.Cache", "T:App.Db");
        AssertIssue("captive", "T:App.Worker", "T:App.Db");
        AssertIssue("captive", "T:App.Reporter", "Microsoft.Extensions.Options.IOptionsSnapshot<TOptions>");
        AssertIssue("captive-transient", "T:App.Notifier", "T:App.Helper");
        AssertIssue("unregistered", "T:App.Handler", "T:App.IMissing");
        AssertIssue("unregistered", "T:App.OrdersController", "T:App.IMissing"); // controllers are built by the framework
        Assert.DoesNotContain(di.Issues, i => i.Consumer == "T:App.Settings"); // instances are not constructed by the container
        Assert.DoesNotContain(di.Issues, i => i.Consumer == "T:App.Built");    // neither are factory-built ones
        Assert.Equal("factory", Reg("T:App.IPlugin", "T:App.Built").Kind);
        Assert.Equal("error", di.Issues[0].Severity);

        Assert.Contains("scoped", graph.Node("T:App.Db").Tags!);
        Assert.Contains("singleton", graph.Node("T:App.IClock").Tags!);
        Assert.Contains(Tags.DiIssue, graph.Node("T:App.Cache").Tags!);
    }

    [Fact]
    public void Recognises_registrations_even_when_the_DI_package_is_not_restored()
    {
        using var ws = new TestWorkspace()
            .Project("Lib")
            .File("Lib/Setup.cs", """
                namespace Lib;
                public interface IFoo { }
                public class Foo : IFoo { public Foo(IBar bar) { } }
                public interface IBar { }
                public static class Setup
                {
                    public static void Register(Microsoft.Extensions.DependencyInjection.IServiceCollection services)
                    {
                        services.AddScoped<IFoo, Foo>();
                    }
                }
                """);

        var di = ws.Analyze().Analysis.Di;

        var registration = Assert.Single(di!.Registrations);
        Assert.Equal(("T:Lib.IFoo", "T:Lib.Foo", "scoped"), (registration.Service, registration.Implementation, registration.Lifetime));
        Assert.Contains(di.Issues, i => i is { Kind: "unregistered", Service: "T:Lib.IBar" });
    }

    [Fact]
    public void Ignores_look_alike_methods_from_other_libraries()
    {
        using var ws = new TestWorkspace()
            .Project("App", sdk: "Microsoft.NET.Sdk.Web")
            .File("App/Fake.cs", """
                namespace App;
                public class Box { public void AddSingleton<T>() { } }
                public class Uses { public void Run() => new Box().AddSingleton<Uses>(); }
                """);

        Assert.Null(ws.Analyze().Analysis.Di);
    }

    private const string Keyed = """
        using Microsoft.Extensions.DependencyInjection;
        using Microsoft.Extensions.DependencyInjection.Extensions;

        namespace App;

        public interface IClock { }
        public class SystemClock : IClock { }
        public class UtcClock : IClock { }
        public interface ITicker { }
        public class Ticker : ITicker { }
        public interface ICache { }
        public class RedisCache : ICache { }
        public class MemoryCache : ICache { }
        public enum Store { Redis, Memory }
        public class Prices([FromKeyedServices("redis")] ICache cache, [FromKeyedServices("utc")] IClock clock);
        public class Stock([FromKeyedServices(Store.Memory)] ICache cache);
        public class Orders(ICache cache, IClock clock);

        public static class Setup
        {
            public static void Register(IServiceCollection services)
            {
                services.AddSingleton<IClock, SystemClock>();
                services.TryAddSingleton<IClock, UtcClock>();
                services.TryAddScoped<RedisCache>();
                services.TryAdd(ServiceDescriptor.Singleton<IClock, UtcClock>());
                services.AddKeyedSingleton(typeof(IClock), "utc", typeof(UtcClock));
                services.AddSingleton(typeof(ITicker), new Ticker());
                services.AddKeyedSingleton<ICache, RedisCache>(serviceKey: "redis");
                services.AddKeyedSingleton<ICache>(Store.Memory, new MemoryCache());
                services
                    .AddScoped<Prices>()
                    .AddScoped<Stock>()
                    .AddScoped<Orders>();
            }
        }
        """;

    [Fact]
    public void Reads_arguments_by_parameter_TryAdd_keys_and_the_line_of_each_call()
    {
        using var ws = new TestWorkspace()
            .Project("App", sdk: "Microsoft.NET.Sdk.Web")
            .File("App/Setup.cs", Keyed);

        var di = ws.Analyze().Analysis.Di!;

        // TryAdd (also of a descriptor) of a service that is already registered does nothing; the first TryAdd of a service registers it.
        Assert.Equal(new[] { "T:App.SystemClock" }, di.Registrations.Where(r => r is { Service: "T:App.IClock", Key: null }).Select(r => r.Implementation));
        Assert.Contains(di.Registrations, r => r is { Service: "T:App.RedisCache", Lifetime: "scoped" });

        // The key of a keyed Type overload is the key, not the service type.
        Assert.Contains(di.Registrations, r => r is { Service: "T:App.IClock", Key: "utc", Implementation: "T:App.UtcClock", Kind: "type" });
        Assert.Contains(di.Registrations, r => r is { Service: "T:App.ICache", Key: "redis", Implementation: "T:App.RedisCache" });
        Assert.Contains(di.Registrations, r => r is { Service: "T:App.ICache", Key: "Store.Memory", Implementation: "T:App.MemoryCache", Kind: "instance" });
        Assert.Contains(di.Registrations, r => r is { Service: "T:App.ITicker", Implementation: "T:App.Ticker", Kind: "instance" });

        // [FromKeyedServices] gets the registration under its key; a plain parameter does not get a keyed one.
        DiDependency Dependency(string consumer, string service) => di.Dependencies.Single(d => d.Consumer == consumer && d.Service == service);
        Assert.Equal("redis", Dependency("T:App.Prices", "T:App.ICache").Key);
        Assert.Equal(new[] { "T:App.RedisCache" }, Dependency("T:App.Prices", "T:App.ICache").Implementations);
        Assert.Equal(new[] { "T:App.UtcClock" }, Dependency("T:App.Prices", "T:App.IClock").Implementations);
        Assert.Equal(new[] { "T:App.MemoryCache" }, Dependency("T:App.Stock", "T:App.ICache").Implementations);
        Assert.Equal(new[] { "T:App.SystemClock" }, Dependency("T:App.Orders", "T:App.IClock").Implementations);
        Assert.Empty(Dependency("T:App.Orders", "T:App.ICache").Implementations);
        var missing = Assert.Single(di.Issues, i => i is { Kind: "unregistered", Consumer: "T:App.Orders" });
        Assert.Contains("only registered under a key", missing.Message);
        Assert.DoesNotContain(di.Issues, i => i.Consumer is "T:App.Prices" or "T:App.Stock");

        // Each call of a fluent chain is on its own line.
        var lines = Keyed.Split('\n');
        int LineOf(string text) => Array.FindIndex(lines, l => l.Contains(text)) + 1;
        foreach (var consumer in new[] { "Prices", "Stock", "Orders" })
        {
            var location = di.Registrations.Single(r => r.Service == "T:App." + consumer).Location!;
            Assert.Equal((LineOf($".AddScoped<{consumer}>()"), LineOf($".AddScoped<{consumer}>()")), (location.Line, location.EndLine));
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void The_context_lifetime_argument_of_AddDbContext_sets_its_lifetime(bool resolved)
    {
        var entityFramework = resolved ? """

            namespace Microsoft.EntityFrameworkCore
            {
                using Microsoft.Extensions.DependencyInjection;
                public class DbContext { }
                public class DbContextOptionsBuilder { }
                public static class EntityFrameworkServiceCollectionExtensions
                {
                    public static IServiceCollection AddDbContext<TContext>(this IServiceCollection serviceCollection,
                        System.Action<DbContextOptionsBuilder>? optionsAction = null,
                        ServiceLifetime contextLifetime = ServiceLifetime.Scoped,
                        ServiceLifetime optionsLifetime = ServiceLifetime.Scoped) where TContext : DbContext => serviceCollection;
                }
            }
            """ : "";
        using var ws = new TestWorkspace()
            .Project("App", sdk: "Microsoft.NET.Sdk.Web")
            .File("App/Setup.cs", """
                using Microsoft.EntityFrameworkCore;
                using Microsoft.Extensions.DependencyInjection;

                namespace App
                {
                    public class ShopDb : DbContext { }
                    public class LogDb : DbContext { }
                    public class CacheDb : DbContext { }
                    public static class Setup
                    {
                        public static void Register(IServiceCollection services)
                        {
                            services.AddDbContext<ShopDb>(o => { }, ServiceLifetime.Transient);
                            services.AddDbContext<LogDb>(optionsLifetime: ServiceLifetime.Singleton);
                            services.AddDbContext<CacheDb>(contextLifetime: ServiceLifetime.Singleton);
                        }
                    }
                }
                """ + entityFramework);

        var di = ws.Analyze().Analysis.Di!;

        string LifetimeOf(string type) => di.Registrations.Single(r => r.Service == "T:App." + type).Lifetime;
        Assert.Equal(("transient", "scoped", "singleton"), (LifetimeOf("ShopDb"), LifetimeOf("LogDb"), LifetimeOf("CacheDb")));
    }

    [Fact]
    public void A_registration_in_a_method_called_before_an_override_in_another_file_loses_to_it()
    {
        using var ws = new TestWorkspace()
            .Project("App", sdk: "Microsoft.NET.Sdk.Web")
            .File("App/Startup.cs", """
                using Microsoft.Extensions.DependencyInjection;
                namespace App;
                public interface IClock { }
                public class SystemClock : IClock { }
                public class FakeClock : IClock { }
                public class Uses(IClock clock);
                public static class Startup
                {
                    public static void Configure(IServiceCollection services)
                    {
                        services.AddDefaults();
                        services.AddSingleton<IClock, FakeClock>();
                        services.AddTransient<Uses>();
                    }
                }
                """)
            .File("App/ZDefaults.cs", """
                using Microsoft.Extensions.DependencyInjection;
                namespace App;
                public static class Defaults
                {
                    public static IServiceCollection AddDefaults(this IServiceCollection services)
                    {
                        services.AddSingleton<IClock, SystemClock>();
                        return services;
                    }
                }
                """);

        var di = ws.Analyze().Analysis.Di!;

        Assert.Equal(new[] { "T:App.SystemClock", "T:App.FakeClock" }, di.Registrations.Where(r => r.Service == "T:App.IClock").Select(r => r.Implementation));
        Assert.Equal(new[] { "T:App.FakeClock" }, di.Dependencies.Single(d => d.Consumer == "T:App.Uses").Implementations);
    }
}
