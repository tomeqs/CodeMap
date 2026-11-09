"""TOML for pyproject.toml and Pipfile: tomllib from Python 3.11, else this small reader of TOML 1.0.

The reader covers what project files hold: tables, arrays of tables, dotted and quoted keys, strings of all four
kinds, numbers, booleans, arrays and inline tables. Dates and times come back as their text.
"""
from __future__ import annotations

import re

try:  # Python 3.11+
    import tomllib as _tomllib
except ImportError:  # pragma: no cover - older Pythons
    _tomllib = None


def loads(text: str) -> dict:
    if _tomllib is not None:
        return _tomllib.loads(text)
    return Reader(text).document()


class TomlError(ValueError):
    pass


_BARE_KEY = re.compile(r"[A-Za-z0-9_-]+")
_NUMBER = re.compile(r"[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|inf|nan|[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?")
_ESCAPES = {"b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r", '"': '"', "\\": "\\", "e": "\x1b"}


class Reader:
    def __init__(self, text: str) -> None:
        self.text = text.replace("\r\n", "\n")
        self.i = 0

    # ------------------------------------------------------------------ document structure

    def document(self) -> dict:
        root: dict = {}
        table = root
        while True:
            self.skip_blank_lines()
            if self.i >= len(self.text):
                return root
            if self.text.startswith("[[", self.i):
                self.i += 2
                keys = self.key()
                self.expect("]]")
                parent = self.walk(root, keys[:-1])
                items = parent.setdefault(keys[-1], [])
                if not isinstance(items, list):
                    raise TomlError(f"{'.'.join(keys)} is not an array of tables")
                table = {}
                items.append(table)
            elif self.peek() == "[":
                self.i += 1
                keys = self.key()
                self.expect("]")
                table = self.walk(root, keys)
            else:
                keys = self.key()
                self.skip_spaces()
                self.expect("=")
                self.skip_spaces()
                value = self.value()
                target = self.walk(table, keys[:-1])
                target[keys[-1]] = value
            self.end_of_line()

    def walk(self, table: dict, keys: list[str]) -> dict:
        for key in keys:
            child = table.setdefault(key, {})
            if isinstance(child, list):  # [[a]] then [a.b]: the last table of the array
                child = child[-1]
            if not isinstance(child, dict):
                raise TomlError(f"{key} is not a table")
            table = child
        return table

    # ------------------------------------------------------------------ keys and values

    def key(self) -> list[str]:
        parts = []
        while True:
            self.skip_spaces()
            ch = self.peek()
            if ch == '"':
                parts.append(self.basic_string())
            elif ch == "'":
                parts.append(self.literal_string())
            else:
                match = _BARE_KEY.match(self.text, self.i)
                if not match:
                    raise self.error("a key")
                parts.append(match.group())
                self.i = match.end()
            self.skip_spaces()
            if self.peek() != ".":
                return parts
            self.i += 1

    def value(self):
        ch = self.peek()
        if self.text.startswith('"""', self.i):
            return self.multiline_basic()
        if self.text.startswith("'''", self.i):
            return self.multiline_literal()
        if ch == '"':
            return self.basic_string()
        if ch == "'":
            return self.literal_string()
        if ch == "[":
            return self.array()
        if ch == "{":
            return self.inline_table()
        if self.text.startswith("true", self.i):
            self.i += 4
            return True
        if self.text.startswith("false", self.i):
            self.i += 5
            return False
        date = _DATE.match(self.text, self.i)
        if date:
            self.i = date.end()
            return date.group()
        number = _NUMBER.match(self.text, self.i)
        if number and number.group():
            self.i = number.end()
            return _number(number.group())
        raise self.error("a value")

    def array(self) -> list:
        self.i += 1
        items = []
        while True:
            self.skip_blank_lines()
            if self.peek() == "]":
                self.i += 1
                return items
            items.append(self.value())
            self.skip_blank_lines()
            if self.peek() == ",":
                self.i += 1
            elif self.peek() != "]":
                raise self.error("',' or ']'")

    def inline_table(self) -> dict:
        self.i += 1
        table: dict = {}
        self.skip_spaces()
        if self.peek() == "}":
            self.i += 1
            return table
        while True:
            keys = self.key()
            self.skip_spaces()
            self.expect("=")
            self.skip_spaces()
            self.walk(table, keys[:-1])[keys[-1]] = self.value()
            self.skip_spaces()
            if self.peek() == ",":
                self.i += 1
                continue
            self.expect("}")
            return table

    def basic_string(self) -> str:
        self.i += 1
        out = []
        while True:
            if self.i >= len(self.text) or self.text[self.i] == "\n":
                raise self.error("the end of the string")
            ch = self.text[self.i]
            if ch == '"':
                self.i += 1
                return "".join(out)
            if ch == "\\":
                out.append(self.escape())
            else:
                out.append(ch)
                self.i += 1

    def literal_string(self) -> str:
        end = self.text.find("'", self.i + 1)
        if end < 0 or "\n" in self.text[self.i + 1 : end]:
            raise self.error("the end of the string")
        value = self.text[self.i + 1 : end]
        self.i = end + 1
        return value

    def multiline_basic(self) -> str:
        self.i += 3
        if self.peek() == "\n":
            self.i += 1
        out = []
        while True:
            if self.i >= len(self.text):
                raise self.error('"""')
            if self.text.startswith('"""', self.i):
                # Up to two quotes may end the string ("""a""""" is a"").
                extra = 0
                while extra < 2 and self.text.startswith('"', self.i + 3 + extra):
                    extra += 1
                out.append('"' * extra)
                self.i += 3 + extra
                return "".join(out)
            ch = self.text[self.i]
            if ch == "\\":
                rest = self.text[self.i + 1 :]
                stripped = rest.lstrip(" \t")
                if stripped.startswith("\n"):  # a line ending backslash joins the lines
                    self.i += 1 + (len(rest) - len(stripped))
                    while self.i < len(self.text) and self.text[self.i] in " \t\n":
                        self.i += 1
                    continue
                out.append(self.escape())
            else:
                out.append(ch)
                self.i += 1

    def multiline_literal(self) -> str:
        start = self.i + 3
        if self.text.startswith("\n", start):
            start += 1
        end = self.text.find("'''", start)
        if end < 0:
            raise self.error("'''")
        extra = 0  # up to two quotes may end the string, as in a basic one
        while extra < 2 and self.text.startswith("'", end + 3 + extra):
            extra += 1
        self.i = end + 3 + extra
        return self.text[start : end + extra]

    def escape(self) -> str:
        code = self.text[self.i + 1 : self.i + 2]
        if code in _ESCAPES:
            self.i += 2
            return _ESCAPES[code]
        if code in ("u", "U"):
            size = 4 if code == "u" else 8
            digits = self.text[self.i + 2 : self.i + 2 + size]
            if len(digits) != size or not all(c in "0123456789abcdefABCDEF" for c in digits):
                raise self.error("a unicode escape")
            self.i += 2 + size
            return chr(int(digits, 16))
        raise self.error("a valid escape")

    # ------------------------------------------------------------------ whitespace

    def peek(self) -> str:
        return self.text[self.i] if self.i < len(self.text) else ""

    def skip_spaces(self) -> None:
        while self.i < len(self.text) and self.text[self.i] in " \t":
            self.i += 1

    def skip_blank_lines(self) -> None:
        while self.i < len(self.text):
            ch = self.text[self.i]
            if ch in " \t\n":
                self.i += 1
            elif ch == "#":
                end = self.text.find("\n", self.i)
                self.i = len(self.text) if end < 0 else end
            else:
                return

    def end_of_line(self) -> None:
        self.skip_spaces()
        if self.peek() == "#":
            end = self.text.find("\n", self.i)
            self.i = len(self.text) if end < 0 else end
        if self.i < len(self.text) and self.text[self.i] != "\n":
            raise self.error("the end of the line")

    def expect(self, token: str) -> None:
        self.skip_spaces()
        if not self.text.startswith(token, self.i):
            raise self.error(f"'{token}'")
        self.i += len(token)

    def error(self, expected: str) -> TomlError:
        line = self.text.count("\n", 0, self.i) + 1
        return TomlError(f"line {line}: expected {expected}")


def _number(text: str):
    clean = text.replace("_", "")
    sign = -1 if clean.startswith("-") else 1
    body = clean.lstrip("+-")
    if body in ("inf", "nan"):
        return float(clean)
    if body.startswith(("0x", "0o", "0b")):
        return sign * int(body[2:], {"x": 16, "o": 8, "b": 2}[body[1]])
    if any(c in body for c in ".eE"):
        return float(clean)
    return int(clean)
