using CodeMap.Model;

namespace CodeMap.Export;

/// <summary>Embeds a graph into the single-file 3D viewer so the result opens with a double click.</summary>
public static class HtmlExporter
{
    /// <summary>Placeholder in viewer/index.html that receives the graph JSON.</summary>
    public const string Placeholder = "<script id=\"codemap-data\" type=\"application/json\">null</script>";

    public static string Export(CodeGraph graph, string template)
    {
        var title = System.Net.WebUtility.HtmlEncode(graph.Source.Name);
        template = template.Replace("<title>CodeMap</title>", $"<title>CodeMap · {title}</title>", StringComparison.Ordinal);
        var index = template.IndexOf(Placeholder, StringComparison.Ordinal);
        if (index < 0) throw new InvalidDataException("The viewer template does not contain the CodeMap data placeholder.");

        // "</" must not appear inside a <script> element.
        var json = JsonExporter.Serialize(graph).Replace("</", "<\\/", StringComparison.Ordinal);
        return template[..index]
               + "<script id=\"codemap-data\" type=\"application/json\">" + json + "</script>"
               + template[(index + Placeholder.Length)..];
    }
}
