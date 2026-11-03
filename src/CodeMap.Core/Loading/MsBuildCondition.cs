namespace CodeMap.Loading;

/// <summary>
/// Evaluates the simple MSBuild conditions projects put on items and item groups:
/// <c>'$(TargetFramework)' == 'net8.0'</c>, <c>!=</c>, <c>and</c> / <c>or</c>, <c>!</c>, parentheses, <c>true</c> / <c>false</c>.
/// Comparisons ignore case, as in MSBuild. Anything else (functions such as Exists(), property functions,
/// item or metadata references) is not understood: <see cref="Evaluate"/> returns null and the caller keeps
/// its default.
/// </summary>
internal static class MsBuildCondition
{
    /// <param name="property">The value of a property ($(Name)); null or empty when it is not set.</param>
    public static bool? Evaluate(string? condition, Func<string, string?> property)
    {
        if (string.IsNullOrWhiteSpace(condition)) return true;
        var tokens = Tokenize(condition, property);
        if (tokens == null) return null;
        var position = 0;
        var result = Or(tokens, ref position);
        return result != null && position == tokens.Count ? result : null;
    }

    private enum Kind { Text, Equal, NotEqual, Not, Open, Close, And, Or }

    private readonly record struct Token(Kind Kind, string Value = "");

    private static List<Token>? Tokenize(string text, Func<string, string?> property)
    {
        var tokens = new List<Token>();
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '\'')
            {
                var end = text.IndexOf('\'', i + 1);
                if (end < 0) return null;
                var value = Expand(text[(i + 1)..end], property);
                if (value == null) return null;
                tokens.Add(new Token(Kind.Text, value));
                i = end + 1;
            }
            else if (c == '$' && i + 1 < text.Length && text[i + 1] == '(')
            {
                var end = text.IndexOf(')', i);
                if (end < 0) return null;
                var value = Expand(text[i..(end + 1)], property);
                if (value == null) return null;
                tokens.Add(new Token(Kind.Text, value));
                i = end + 1;
            }
            else if (text.AsSpan(i).StartsWith("==")) { tokens.Add(new Token(Kind.Equal)); i += 2; }
            else if (text.AsSpan(i).StartsWith("!=")) { tokens.Add(new Token(Kind.NotEqual)); i += 2; }
            else if (c == '!') { tokens.Add(new Token(Kind.Not)); i++; }
            else if (c == '(') { tokens.Add(new Token(Kind.Open)); i++; }
            else if (c == ')') { tokens.Add(new Token(Kind.Close)); i++; }
            else if (char.IsLetter(c))
            {
                var start = i;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                var word = text[start..i];
                if (word.Equals("and", StringComparison.OrdinalIgnoreCase)) tokens.Add(new Token(Kind.And));
                else if (word.Equals("or", StringComparison.OrdinalIgnoreCase)) tokens.Add(new Token(Kind.Or));
                else if (word.Equals("true", StringComparison.OrdinalIgnoreCase) || word.Equals("false", StringComparison.OrdinalIgnoreCase)) tokens.Add(new Token(Kind.Text, word.ToLowerInvariant()));
                else return null; // Exists(...), HasTrailingSlash(...)...
            }
            else
            {
                return null;
            }
        }

        return tokens;
    }

    /// <summary>Replaces $(Name) in a quoted value; null for what we can't evaluate (property functions, @(), %()).</summary>
    private static string? Expand(string value, Func<string, string?> property)
    {
        if (value.Contains("@(") || value.Contains("%(")) return null;
        var result = new System.Text.StringBuilder();
        var i = 0;
        while (i < value.Length)
        {
            var start = value.IndexOf("$(", i, StringComparison.Ordinal);
            if (start < 0)
            {
                result.Append(value, i, value.Length - i);
                break;
            }

            result.Append(value, i, start - i);
            var end = value.IndexOf(')', start);
            if (end < 0) return null;
            var name = value[(start + 2)..end].Trim();
            if (name.Length == 0 || !name.All(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-')) return null; // $(X.Method()), $([System...])
            result.Append(property(name) ?? "");
            i = end + 1;
        }

        return result.ToString();
    }

    private static bool? Or(List<Token> tokens, ref int position)
    {
        var left = And(tokens, ref position);
        while (left != null && position < tokens.Count && tokens[position].Kind == Kind.Or)
        {
            position++;
            var right = And(tokens, ref position);
            left = right == null ? null : left.Value || right.Value;
        }

        return left;
    }

    private static bool? And(List<Token> tokens, ref int position)
    {
        var left = Unary(tokens, ref position);
        while (left != null && position < tokens.Count && tokens[position].Kind == Kind.And)
        {
            position++;
            var right = Unary(tokens, ref position);
            left = right == null ? null : left.Value && right.Value;
        }

        return left;
    }

    private static bool? Unary(List<Token> tokens, ref int position)
    {
        if (position >= tokens.Count) return null;
        var token = tokens[position];
        if (token.Kind == Kind.Not)
        {
            position++;
            return !Unary(tokens, ref position);
        }

        if (token.Kind == Kind.Open)
        {
            position++;
            var inner = Or(tokens, ref position);
            if (inner == null || position >= tokens.Count || tokens[position].Kind != Kind.Close) return null;
            position++;
            return inner;
        }

        if (token.Kind != Kind.Text) return null;
        position++;
        if (position < tokens.Count && tokens[position].Kind is Kind.Equal or Kind.NotEqual)
        {
            var op = tokens[position++].Kind;
            if (position >= tokens.Count || tokens[position].Kind != Kind.Text) return null;
            var right = tokens[position++].Value;
            var equal = string.Equals(token.Value, right, StringComparison.OrdinalIgnoreCase);
            return op == Kind.Equal ? equal : !equal;
        }

        return token.Value switch
        {
            "true" => true,
            "false" => false,
            _ => null,
        };
    }
}
