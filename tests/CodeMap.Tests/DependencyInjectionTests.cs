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
}
