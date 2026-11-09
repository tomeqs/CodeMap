using CodeMap.Languages;
using CodeMap.Languages.External;
using CodeMap.Server;

namespace CodeMap.Tests;

/// <summary>
/// What a plugin needs from CodeMap besides the protocol: finding its runtime (python3, python or py -3, of a
/// major.minor version, which may answer on stderr or not at all), and knowing its code by file and folder
/// (scripts without a project file, virtual environments by their pyvenv.cfg, *.egg-info, generated files).
/// </summary>
public class RuntimeAndDetectionTests
{
    [Theory]
    [InlineData("Python 3.12.1", 3, 12)]
    [InlineData("v22.23.4", 22, 23)]
    [InlineData("18", 18, 0)]
    [InlineData("3.9", 3, 9)]
    [InlineData("Python 2.7.18", 2, 7)]
    public void Versions_are_read_as_major_and_minor(string text, int major, int minor)
    {
        Assert.Equal(new Version(major, minor), RuntimeLocator.ParseVersion(text));
    }

    [Fact]
    public void The_version_text_without_a_number_is_none()
    {
        Assert.Null(RuntimeLocator.ParseVersion("Python"));
    }

    [Fact]
    public void A_runtime_is_the_first_candidate_that_says_a_new_enough_version()
    {
        if (OperatingSystem.IsWindows()) return; // the fake programs are shell scripts
        using var ws = new TestWorkspace();
        var stub = Program(ws, "store-alias", "exit 9009");                              // prints nothing: the Windows Store alias
        var old = Program(ws, "old-python", "echo 'Python 3.8.10'");                    // too old
        var launcher = Program(ws, "launcher", "if [ \"$1\" = \"-3\" ]; then echo 'Python 3.12.1' >&2; else exit 1; fi"); // answers on stderr

        var spec = new PluginManifest.RuntimeSpec
        {
            Name = "python3",
            MinVersion = "3.9",
            Candidates = new() { new() { Path.Combine(ws.Root, "missing") }, new() { stub }, new() { old }, new() { launcher, "-3" } },
            Help = "Install Python 3.9 or newer.",
        };

        var (runtime, problem) = RuntimeLocator.Find(spec);

        Assert.Null(problem);
        Assert.Equal(launcher, runtime!.Path);
        Assert.Equal(new[] { "-3" }, runtime.Arguments);
        Assert.Equal("Python 3.12.1", runtime.Version);
    }

    [Fact]
    public void Without_a_usable_runtime_the_problem_names_each_candidate()
    {
        if (OperatingSystem.IsWindows()) return;
        using var ws = new TestWorkspace();
        var stub = Program(ws, "store-alias", "exit 9009");
        var old = Program(ws, "old-python", "echo 'Python 2.7.18' >&2");

        var (runtime, problem) = RuntimeLocator.Find(new PluginManifest.RuntimeSpec
        {
            Name = "python3",
            MinVersion = "3.9",
            Candidates = new() { new() { stub }, new() { old } },
            Help = "Install Python 3.9 or newer.",
        });

        Assert.Null(runtime);
        Assert.Contains("does not say its version", problem);
        Assert.Contains("Microsoft Store alias", problem);
        Assert.Contains("is Python 2.7.18, too old: 3.9 or newer is needed", problem);
        Assert.EndsWith("Install Python 3.9 or newer.", problem);

        var (none, missing) = RuntimeLocator.Find(new PluginManifest.RuntimeSpec
        {
            Name = "python3",
            Candidates = new() { new() { "codemap-no-such-python3" }, new() { "codemap-no-such-python" }, new() { "codemap-no-such-py", "-3" } },
        });
        Assert.Null(none);
        Assert.Equal("codemap-no-such-python3, codemap-no-such-python or codemap-no-such-py was not found on the PATH.", missing);
    }

    [Fact]
    public void A_runtime_named_in_its_variable_is_used_as_it_is()
    {
        if (OperatingSystem.IsWindows()) return;
        using var ws = new TestWorkspace();
        var old = Program(ws, "chosen", "echo 'Python 3.6.0'");
        var variable = "CODEMAP_TEST_RUNTIME_" + Guid.NewGuid().ToString("N");
        Environment.SetEnvironmentVariable(variable, old);
        try
        {
            var (runtime, problem) = RuntimeLocator.Find(new PluginManifest.RuntimeSpec { Name = "python3", MinVersion = "3.9", EnvVar = variable });

            Assert.Null(problem); // the user's (or the editor's) choice
            Assert.Equal(old, runtime!.Path);
        }
        finally
        {
            Environment.SetEnvironmentVariable(variable, null);
        }
    }

    [Fact]
    public void A_manifest_takes_candidates_and_a_major_minor_version()
    {
        using var ws = new TestWorkspace()
            .File("py/codemap-plugin.json", Manifest("py", """
                "runtime": { "name": "python3", "minVersion": "3.9", "candidates": [["python3"], ["python"], ["py", "-3"]], "envVar": "CODEMAP_PYTHON" },
                "detect": { "markers": ["pyproject.toml"], "sources": [".py"], "ignoreDirs": ["__pycache__", "*.egg-info"], "ignoreMarkers": ["pyvenv.cfg"], "excludeFiles": ["*_pb2.py"], "withoutMarker": true }
                """))
            .File("node/codemap-plugin.json", Manifest("node", """
                "runtime": { "name": "node", "minVersion": 18 },
                "detect": { "sources": [".js"] }
                """))
            .File("bad-version/codemap-plugin.json", Manifest("badversion", """
                "runtime": { "name": "x", "minVersion": "latest" }, "detect": { "sources": [".x"] }
                """))
            .File("no-candidates/codemap-plugin.json", Manifest("nocandidates", """
                "runtime": { "name": "x", "candidates": [] }, "detect": { "sources": [".x"] }
                """))
            .File("empty-candidate/codemap-plugin.json", Manifest("emptycandidate", """
                "runtime": { "name": "x", "candidates": [["x"], []] }, "detect": { "sources": [".x"] }
                """))
            .File("marker-only/codemap-plugin.json", Manifest("markeronly", """
                "detect": { "inputs": ["*.x"], "withoutMarker": true }
                """));

        var found = PluginCatalog.Discover(new[] { ws.Root });

        Assert.Equal(new[] { "node", "py" }, found.Plugins.Select(p => p.Id).Order());
        var py = found.Plugins.Single(p => p.Id == "py");
        Assert.Equal("3.9", py.Runtime!.MinVersion);
        Assert.Equal(new[] { "python3", "python", "py -3" }, py.Runtime.Commands.Select(c => string.Join(" ", c)));
        Assert.True(py.Detect.WithoutMarker);
        Assert.Equal(new[] { "pyvenv.cfg" }, py.Detect.IgnoreMarkers);
        Assert.Equal("18", found.Plugins.Single(p => p.Id == "node").Runtime!.MinVersion);
        Assert.Equal(new[] { "node" }, found.Plugins.Single(p => p.Id == "node").Runtime!.Commands.Select(c => c[0]));

        Assert.Equal(4, found.Problems.Count);
        Assert.Contains(found.Problems, p => p.Contains("runtime.minVersion 'latest' is not a version"));
        Assert.Equal(2, found.Problems.Count(p => p.Contains("runtime.candidates must each be a program")));
        Assert.Contains(found.Problems, p => p.Contains("detect.withoutMarker needs sources"));
    }

    [Fact]
    public void Code_without_a_project_file_counts_when_the_language_says_so()
    {
        using var ws = new TestWorkspace().File("scripts/tool.py", "print(1)").File("other/notes.txt", "");

        // A folder of scripts is a project of its own…
        Assert.True(Python(ws, withoutMarker: true).Detect(Path.Combine(ws.Root, "scripts"), CancellationToken.None));
        Assert.False(Python(ws, withoutMarker: false).Detect(Path.Combine(ws.Root, "scripts"), CancellationToken.None));
        Assert.False(Python(ws, withoutMarker: true).Detect(Path.Combine(ws.Root, "other"), CancellationToken.None));
        // …but a script deep in another language's repository does not make the repository a Python one.
        Assert.False(Python(ws, withoutMarker: true).Detect(ws.Root, CancellationToken.None));
    }

    [Fact]
    public void Virtual_environments_wildcard_folders_and_excluded_files_are_not_code()
    {
        using var ws = new TestWorkspace()
            .File("pyproject.toml", "")
            .File("my-env/pyvenv.cfg", "home = /usr/bin")               // a virtual environment, whatever its name
            .File("my-env/lib/python3.12/site-packages/x/core.py", "")
            .File("pkg.egg-info/stub.py", "")
            .File("proto/orders_pb2.py", "");                           // generated

        var python = Python(ws, withoutMarker: true);

        Assert.False(python.Detect(ws.Root, CancellationToken.None));
        Assert.False(python.IsWatched(Path.Combine(ws.Root, "proto", "orders_pb2.py")));
        Assert.True(python.IsWatched(Path.Combine(ws.Root, "proto", "orders.py")));

        ws.File("app/main.py", "");
        Assert.True(python.Detect(ws.Root, CancellationToken.None));
    }

    [Fact]
    public void TypeScript_says_itself_which_files_are_not_its_code()
    {
        var manifest = PluginManifest.Load(Path.Combine(GoldenTests.RepoRoot(), "analyzers", "typescript", PluginManifest.FileName));
        var typescript = new ExternalProcessAnalyzer(manifest);

        Assert.True(typescript.IsWatched("/repo/src/orders.ts"));
        Assert.False(typescript.IsWatched("/repo/src/orders.d.ts"));
        Assert.False(typescript.IsWatched("/repo/dist/app.min.js"));
        Assert.False(typescript.IsWatched("/repo/types/x.d.mts"));
    }

    [Fact]
    public void The_app_neither_lists_nor_watches_a_virtual_environment()
    {
        using var ws = new TestWorkspace()
            .File("pyproject.toml", "")
            .File("app/main.py", "")
            .File(".venv/pyvenv.cfg", "")
            .File("env/pyvenv.cfg", "")
            .File("env/lib/site.py", "")
            .File("dist-info.egg-info/x.py", "")
            .File("environment/readme.md", "");               // a folder named like one, but no pyvenv.cfg
        var registry = new LanguageRegistry(new ILanguageAnalyzer[] { new Languages.CSharp.CSharpAnalyzer(), Python(ws, withoutMarker: true) });

        var listing = DirectoryBrowser.Browse(ws.Root, ws.Root, registry);
        Assert.Equal(new[] { "app", "environment" }, listing.Entries.Where(e => e.Kind == "folder").Select(e => e.Name));

        Assert.True(SourceChangeFilter.IsRelevant(Path.Combine(ws.Root, "app", "main.py"), registry, ws.Root));
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(ws.Root, "env", "lib", "site.py"), registry, ws.Root));
        Assert.False(SourceChangeFilter.IsRelevant(Path.Combine(ws.Root, "dist-info.egg-info", "x.py"), registry, ws.Root));
    }

    /// <summary>A Python-like language from a manifest alone (no runtime needed to detect files).</summary>
    private static ExternalProcessAnalyzer Python(TestWorkspace ws, bool withoutMarker)
    {
        var folder = Path.Combine(ws.Root, "..", "manifest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, PluginManifest.FileName);
        File.WriteAllText(path, Manifest("python", $$"""
            "detect": {
              "markers": ["pyproject.toml", "setup.py"], "sources": [".py"], "inputs": ["*.py", "pyproject.toml"],
              "ignoreDirs": ["__pycache__", "*.egg-info"], "ignoreMarkers": ["pyvenv.cfg"], "excludeFiles": ["*_pb2.py"],
              "withoutMarker": {{(withoutMarker ? "true" : "false")}}
            }
            """));
        try
        {
            return new ExternalProcessAnalyzer(PluginManifest.Load(path));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    private static string Manifest(string id, string rest) => $$"""
        { "protocol": 1, "id": "{{id}}", "idPrefix": "{{id}}:", "name": "{{id}}", "command": ["{{id}}"], {{rest}} }
        """;

    /// <summary>A shell script that plays a runtime's --version.</summary>
    private static string Program(TestWorkspace ws, string name, string body)
    {
        var path = Path.Combine(ws.Root, name);
        File.WriteAllText(path, "#!/bin/sh\n" + body + "\n");
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return path;
    }
}
