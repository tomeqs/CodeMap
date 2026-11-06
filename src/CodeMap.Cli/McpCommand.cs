using System.Runtime.InteropServices;
using CodeMap.Analysis;
using CodeMap.Languages;
using CodeMap.Languages.External;
using CodeMap.Mcp;

/// <summary>
/// <c>codemap mcp</c>: the MCP server on stdin/stdout. Stdout belongs to the protocol from the first moment, so everything
/// else (logs, warnings, a stray Console.WriteLine) goes to stderr.
/// </summary>
internal static class McpCommand
{
    public static int Run(string[] args)
    {
        var protocolOut = Console.OpenStandardOutput();
        var protocolIn = Console.OpenStandardInput();
        Console.SetOut(Console.Error);

        string? path = null, root = null, plugins = null, browser = null;
        List<string>? languages = null;
        var watch = true;
        var maxOutput = 30_000;
        var analyzer = new AnalyzerOptions { CodeChecks = true };
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {arg}.");
            switch (arg)
            {
                case "-h" or "--help":
                    Console.Error.WriteLine("codemap mcp [path] [--root <dir>] [--no-watch] [--max-output <n>] [--lang <list>] [--plugins <dir>] [--browser <path>] [--no-git] [--no-checks] [--git-since <when>] [--no-tests] [--generated] [--external]");
                    return 0;
                case "--root": root = Path.GetFullPath(Next()); break;
                case "--no-watch": watch = false; break;
                case "--max-output":
                    maxOutput = int.TryParse(Next(), out var n) && n >= 2000 ? n : throw new ArgumentException("--max-output expects a number of at least 2000.");
                    break;
                case "--lang": languages = Next().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList(); break;
                case "--plugins": plugins = Path.GetFullPath(Next()); break;
                case "--browser": browser = Next(); break;
                case "--no-git": analyzer.Git = false; break;
                case "--no-checks": analyzer.CodeChecks = false; break;
                case "--git-since": analyzer.GitSince = Next(); break;
                case "--no-tests": analyzer.IncludeTests = false; break;
                case "--generated": analyzer.IncludeGenerated = true; break;
                case "--external": analyzer.IncludeExternal = true; break;
                default:
                    if (arg.StartsWith('-')) throw new ArgumentException($"Unknown option {arg} for codemap mcp.");
                    if (path != null) throw new ArgumentException($"Unexpected argument '{arg}'.");
                    path = arg;
                    break;
            }
        }

        LanguageRegistry Registry()
        {
            var registry = plugins != null ? LanguageRegistry.WithPlugins(PluginCatalog.DefaultFolders().Prepend(plugins)) : LanguageRegistry.Default;
            return languages != null ? registry.Only(languages) : registry;
        }

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stop.Cancel();
        };

        // A client that stops the server with SIGTERM (or whose terminal goes away: SIGHUP) gets the same clean stop as
        // Ctrl+C: the session closes, and with it the browser used for render_map. (On Windows, where a kill cannot be
        // caught, the browser is in a job object that dies with codemap.)
        using var terminate = Register(PosixSignal.SIGTERM, stop);
        using var hangUp = Register(PosixSignal.SIGHUP, stop);

        var options = new CodeMapMcpOptions
        {
            Path = path,
            Root = root,
            Watch = watch,
            Analyzer = analyzer,
            Registry = Registry,
            MaxOutput = maxOutput,
            Log = Console.Error,
            Browser = browser,
            ViewerHtml = () =>
            {
                using var stream = typeof(McpCommand).Assembly.GetManifestResourceStream("CodeMap.viewer.html");
                if (stream == null) return null;
                using var reader = new StreamReader(stream, System.Text.Encoding.UTF8);
                return reader.ReadToEnd();
            },
            Version = typeof(CodeMap.Model.CodeGraph).Assembly.GetName().Version?.ToString(3) ?? "0.0.0",
        };
        var running = CodeMapMcpServer.RunAsync(options, protocolIn, protocolOut, stop.Token);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (stop.Token.Register(() => stopped.TrySetResult()))
        {
            Task.WaitAny(running, stopped.Task);
        }

        // Asked to stop: the session is closed by then, but the server may still be blocked reading an open stdin
        // (which cannot be interrupted). A few seconds to finish, then the process ends anyway.
        if (!running.IsCompleted) Task.WaitAny(running, Task.Delay(TimeSpan.FromSeconds(2)));
        if (running.IsCompleted)
        {
            try
            {
                running.GetAwaiter().GetResult();
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
            }
            catch (Exception ex) when (stop.IsCancellationRequested)
            {
                // Asked to stop: what failed on the way out (a tool call meeting the closed session) is not an error.
                Console.Error.WriteLine($"codemap mcp stopped: {ex.Message}");
            }
        }

        return 0;
    }

    private static PosixSignalRegistration? Register(PosixSignal signal, CancellationTokenSource stop)
    {
        try
        {
            return PosixSignalRegistration.Create(signal, context =>
            {
                context.Cancel = true;
                stop.Cancel();
            });
        }
        catch (PlatformNotSupportedException)
        {
            return null;
        }
    }
}
