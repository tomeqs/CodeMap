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

        string? path = null, root = null, plugins = null;
        List<string>? languages = null;
        var watch = true;
        var maxOutput = 30_000;
        var analyzer = new AnalyzerOptions();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {arg}.");
            switch (arg)
            {
                case "-h" or "--help":
                    Console.Error.WriteLine("codemap mcp [path] [--root <dir>] [--no-watch] [--max-output <n>] [--lang <list>] [--plugins <dir>] [--no-git] [--git-since <when>] [--no-tests] [--generated] [--external]");
                    return 0;
                case "--root": root = Path.GetFullPath(Next()); break;
                case "--no-watch": watch = false; break;
                case "--max-output":
                    maxOutput = int.TryParse(Next(), out var n) && n >= 2000 ? n : throw new ArgumentException("--max-output expects a number of at least 2000.");
                    break;
                case "--lang": languages = Next().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList(); break;
                case "--plugins": plugins = Path.GetFullPath(Next()); break;
                case "--no-git": analyzer.Git = false; break;
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

        var options = new CodeMapMcpOptions
        {
            Path = path,
            Root = root,
            Watch = watch,
            Analyzer = analyzer,
            Registry = Registry,
            MaxOutput = maxOutput,
            Log = Console.Error,
            Version = typeof(CodeMap.Model.CodeGraph).Assembly.GetName().Version?.ToString(3) ?? "0.0.0",
        };
        try
        {
            CodeMapMcpServer.RunAsync(options, protocolIn, protocolOut, stop.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
        }

        return 0;
    }
}
