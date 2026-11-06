using CodeMap.Analysis;
using CodeMap.Insights;
using CodeMap.Model;

namespace CodeMap.Tests;

/// <summary>Checks inside C# function bodies (--checks): each rule on code that has the problem and on a near miss.</summary>
public class CodeChecksTests
{
    private static readonly AnalyzerOptions Checks = new() { Git = false, CodeChecks = true };

    private static readonly Lazy<CodeGraph> Graph = new(() =>
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/Checks.cs", """
            using System;
            using System.IO;
            using System.Net.Http;
            using System.Threading.Tasks;

            namespace App;

            public class Exceptions
            {
                public void Empty() { try { Work(); } catch { } }
                public void EmptyOnPurpose() { try { Work(); } catch (IOException) { /* the file may be gone: fine */ } }
                public void Swallowed() { try { Work(); } catch (Exception) { Work(); } }
                public void Logged(Action<string> log) { try { Work(); } catch (Exception ex) { log(ex.Message); } }
                public void Rethrow() { try { Work(); } catch (Exception ex) { Console.Error.WriteLine(ex); throw ex; } }
                public void RethrowRight() { try { Work(); } catch (Exception ex) { Console.Error.WriteLine(ex); throw; } }
                public void ThrowInFinally() { try { Work(); } finally { throw new InvalidOperationException(); } }
                private void Work() { }
            }

            public class Async
            {
                public async void Fire() { await Task.Delay(1); }
                public async void OnClick(object sender, EventArgs e) { await Task.Delay(1); }
                public int Blocking(Task<int> task) => task.Result;
                public void Waiting(Task task) => task.Wait();
                public int Awaiter(Task<int> task) => task.GetAwaiter().GetResult();
                public async Task<int> Fine(Task<int> task) => await task;
                public async Task Forgotten() { Task.Delay(1); await Task.Delay(1); }
            }

            public class Other
            {
                private readonly object _gate = new();
                public void LockThis() { lock (this) { } }
                public void LockRight() { lock (_gate) { } }
                public bool Same(double a, double b) => a == b;
                public bool Zero(double a) => a == 0;
                public int Name { get => Name; set => Name = value; }
                private int _size;
                public int Size { get => _size; set => _size = value; }
                public int Unreachable() { return 1; Console.WriteLine(); }
                public void Unused() { int x; }
            }

            public class Resources
            {
                public string Leak() { var reader = new StreamReader("a.txt"); return reader.ReadToEnd(); }
                public string Disposed() { using var reader = new StreamReader("a.txt"); return reader.ReadToEnd(); }
                public StreamReader Returned() { var reader = new StreamReader("a.txt"); return reader; }
                public long Harmless() { var memory = new MemoryStream(); return memory.Length; }
                public void Passed(Action<HttpClient> use) { var client = new HttpClient(); use(client); }
            }
            """);
        return ws.Analyze(options: Checks);
    });

    private static CodeDiagnostic One(string rule, string member)
    {
        var all = Graph.Value.Analysis.Diagnostics!;
        var matches = all.Where(d => d.Rule == rule && d.Node?.Contains(member, StringComparison.Ordinal) == true).ToList();
        if (matches.Count == 1) return matches[0];
        throw new Xunit.Sdk.XunitException($"Expected one {rule} in {member}, found {matches.Count}: {string.Join(", ", all.Select(d => $"{d.Rule}@{d.Node}"))}");
    }

    private static void None(string rule, string member) =>
        Assert.DoesNotContain(Graph.Value.Analysis.Diagnostics!, d => d.Rule == rule && d.Node?.Contains(member, StringComparison.Ordinal) == true);

    [Fact]
    public void Exceptions_that_disappear_or_lose_their_stack_are_reported()
    {
        Assert.Equal("warning", One("empty-catch", "Exceptions.Empty").Severity);
        None("empty-catch", "EmptyOnPurpose");
        Assert.Equal("exceptions", One("swallowed-exception", "Exceptions.Swallowed").Category);
        None("swallowed-exception", "Logged");
        Assert.Contains("throw;", One("rethrow-loses-stack", "Exceptions.Rethrow").Message);
        None("rethrow-loses-stack", "RethrowRight");
        One("throw-in-finally", "ThrowInFinally");
    }

    [Fact]
    public void Async_mistakes_are_reported_and_event_handlers_may_be_async_void()
    {
        One("async-void", "Async.Fire");
        None("async-void", "OnClick");
        Assert.Contains(".Result", One("sync-over-async", "Async.Blocking").Message);
        Assert.Contains(".Wait()", One("sync-over-async", "Async.Waiting").Message);
        Assert.Contains("GetResult", One("sync-over-async", "Async.Awaiter").Message);
        None("sync-over-async", "Async.Fine");
        Assert.Equal("compiler", One("CS4014", "Async.Forgotten").Source);
    }

    [Fact]
    public void Locks_equality_and_self_calling_properties_are_reported()
    {
        One("lock-on-this", "LockThis");
        None("lock-on-this", "LockRight");
        One("float-equality", "Other.Same");
        None("float-equality", "Other.Zero");
        var recursive = Graph.Value.Analysis.Diagnostics!.Where(d => d.Rule == "recursive-property").ToList();
        Assert.Equal(2, recursive.Count); // the getter and the setter of Name, not Size
        Assert.All(recursive, d => Assert.Equal("error", d.Severity));
        One("CS0162", "Other.Unreachable");
        One("CS0168", "Other.Unused");
    }

    [Fact]
    public void Disposables_nobody_disposes_are_reported_unless_someone_else_may_own_them()
    {
        Assert.Contains("'reader' is a StreamReader", One("disposable-not-disposed", "Resources.Leak").Message);
        None("disposable-not-disposed", "Disposed");
        None("disposable-not-disposed", "Returned");
        None("disposable-not-disposed", "Harmless");
        None("disposable-not-disposed", "Passed");
    }

    [Fact]
    public void Diagnostics_have_a_place_and_a_node_and_are_off_by_default()
    {
        var all = Graph.Value.Analysis.Diagnostics!;
        Assert.All(all, d =>
        {
            Assert.Equal("App/Checks.cs", d.Location.File);
            Assert.True(d.Location.Line > 0 && d.Column > 0);
            Assert.NotNull(d.Node);
        });
        Assert.Equal(all.OrderBy(d => d.Location.Line).ThenBy(d => d.Column).Select(d => d.Rule), all.Select(d => d.Rule));

        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", "namespace App; public class A { public void M() { try { } catch { } } }");
        Assert.Null(ws.Analyze().Analysis.Diagnostics);
        Assert.Single(ws.Analyze(options: Checks).Analysis.Diagnostics!);
    }

    [Fact]
    public void Nullable_warnings_need_the_project_to_enable_nullable_and_no_warn_is_respected()
    {
        const string code = "namespace App; public class A { public int Length(string? s) => s.Length; public void M() { int unused; } }";
        using var on = new TestWorkspace().Project("App");
        on.File("App/A.cs", code);
        Assert.Contains(on.Analyze(options: Checks).Analysis.Diagnostics!, d => d.Rule == "CS8602");

        using var off = new TestWorkspace().Project("App", extra: "<Nullable>disable</Nullable><NoWarn>$(NoWarn);0168</NoWarn>");
        off.File("App/A.cs", "#nullable enable\n" + code);
        var diagnostics = off.Analyze(options: Checks).Analysis.Diagnostics!;
        Assert.DoesNotContain(diagnostics, d => d.Rule.StartsWith("CS86", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Rule == "CS0168");
    }

    [Fact]
    public void Unresolved_packages_do_not_make_type_based_checks_fire()
    {
        using var ws = new TestWorkspace().Project("App");
        ws.File("App/A.cs", """
            using Missing.Package;
            namespace App;
            public class A
            {
                public int Count(Client? client) => client.Items.Count;
                public void Use() { var widget = new Widget(); widget.Run(); }
                public bool Same(Measure a, Measure b) => a == b;
            }
            """);
        var diagnostics = ws.Analyze(options: Checks).Analysis.Diagnostics!;
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Each_diagnostic_is_a_code_finding()
    {
        var report = FindingsAnalysis.Compute(Graph.Value);
        var code = report.Findings.Where(f => f.Category == FindingCategory.Code).ToList();
        Assert.Equal(Graph.Value.Analysis.Diagnostics!.Count, code.Count);
        var recursive = code.First(f => f.Rule == "code.recursive-property");
        Assert.Equal(FindingSeverity.Error, recursive.Severity);
        Assert.StartsWith("code.recursive-property@P:App.Other.Name", recursive.Id);
        Assert.Equal("App/Checks.cs", recursive.Locations[0].File);
        Assert.Equal(code.Count, code.Select(f => f.Id).Distinct().Count());
    }

    [NodeFact(typescript: true)]
    public void Both_languages_of_a_folder_are_checked_and_their_diagnostics_point_at_nodes_of_the_map()
    {
        using var ws = new TestWorkspace().Project("Api");
        ws.File("Api/A.cs", "namespace Api; public class A { public void M() { try { } catch { } } }");
        ws.File("client/package.json", """{ "name": "client", "version": "1.0.0" }""");
        ws.File("client/src/b.ts", "export function f() {\n  try { g(); } catch { }\n}\nexport function g() { }\n");
        var graph = CodeMapAnalyzer.Analyze(ws.Root, BookingSampleTests.Registry, Checks);

        var diagnostics = graph.Analysis.Diagnostics!;
        Assert.Equal(new[] { "Api/A.cs", "client/src/b.ts" }, diagnostics.Select(d => d.Location.File).Order(StringComparer.Ordinal));
        Assert.All(diagnostics, d => Assert.Equal("empty-catch", d.Rule));
        Assert.Equal("ts:client:src/b.ts#f", diagnostics.Single(d => d.Location.File.StartsWith("client")).Node);
        Assert.Equal("M:Api.A.M", diagnostics.Single(d => d.Location.File.StartsWith("Api")).Node);
    }
}
