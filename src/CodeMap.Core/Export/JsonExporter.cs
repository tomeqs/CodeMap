using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using CodeMap.Model;

namespace CodeMap.Export;

public static class JsonExporter
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    private static readonly JsonSerializerOptions Indented = new(Options) { WriteIndented = true };

    public static string Serialize(CodeGraph graph, bool indented = false) =>
        JsonSerializer.Serialize(graph, indented ? Indented : Options);

    public static void Write(CodeGraph graph, Stream stream, bool indented = false) =>
        JsonSerializer.Serialize(stream, graph, indented ? Indented : Options);

    public static CodeGraph Read(Stream stream) =>
        JsonSerializer.Deserialize<CodeGraph>(stream, Options) ?? throw new InvalidDataException("Empty CodeMap document.");

    public static CodeGraph Read(string path)
    {
        using var stream = File.OpenRead(path);
        return Read(stream);
    }
}
