"""The note of a task as plain text (``datenmodell.md``, "Notiz (Markdown, seit 07.11.2026)").

Notes are Markdown. Search, notifications and previews take them as plain text: the marks gone, a picture as
"[Bild]" ("[Image]" in other languages), a link as its text. The same rule runs on the server, in the web
(``frontend/src/lib/notes.ts``) and in the app; ``pruefsaetze/notiz-klartext.json`` holds the cases all of them pass.

The rule, line by line (it is not a full CommonMark parser, on purpose: small, the same everywhere):

* Fenced code (```` ``` ```` or ``~~~``): the lines inside stay as they are, the fences go.
* Quote marks ``>`` at the start go; a thematic break (``---``, ``***``, ``___``) and a setext line (``===``) become
  an empty line; ``#`` of a heading goes, and closing ``#`` after it.
* A list mark (``-``, ``*``, ``+``, ``1.``, ``1)``) goes; a task box after it becomes ``☐`` (open) or ``☑`` (done).
  Indentation at the start of a line goes.
* Inline: code spans keep their content untouched; a backslash escape keeps the character; ``![alt](…)`` becomes
  the picture word; ``[text](url)`` its text (the address when there is no text); ``<https://…>`` the address;
  ``**``, ``__``, ``~~``, ``*`` and ``_`` around words go (``_`` and ``__`` only outside a word). HTML stays as text.
* Space at the end of a line and a closing backslash go; empty lines in a row become one; the whole is trimmed.
"""

from __future__ import annotations

import re

PICTURE = {"de": "[Bild]", "en": "[Image]"}

#: Letters and digits a ``_`` mark must not touch (the same class as in the web, without ``\\w`` differences).
_WORD = "0-9A-Za-zÀ-ÖØ-öø-ÿ"

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_QUOTE = re.compile(r"^ {0,3}> ?")
_BREAK = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_SETEXT = re.compile(r"^ {0,3}=+[ \t]*$")
_HEADING = re.compile(r"^ {0,3}#{1,6}(?:[ \t]+|$)")
_HEADING_END = re.compile(r"[ \t]+#+[ \t]*$")
_LIST = re.compile(r"^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+")
_TASK = re.compile(r"^\[([ xX])\][ \t]+")

_CODE = re.compile(r"(`+)(.+?)\1")
_ESCAPE = re.compile(r"\\([!-/:-@\[-`{-~])")
_IMAGE = re.compile(r'!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)')
_LINK = re.compile(r'\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)')
_AUTOLINK = re.compile(r"<((?:https?://|mailto:)[^>\s]+)>")
_MARKS = [
    re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*"),
    re.compile(rf"(?<![{_WORD}])__(?=\S)(.+?)(?<=\S)__(?![{_WORD}])"),
    re.compile(r"~~(?=\S)(.+?)(?<=\S)~~"),
    re.compile(r"\*(?=\S)(.+?)(?<=\S)\*"),
    re.compile(rf"(?<![{_WORD}])_(?=\S)(.+?)(?<=\S)_(?![{_WORD}])"),
]


def _inline(text: str, picture: str) -> str:
    kept: list[str] = []

    def keep(value: str) -> str:
        kept.append(value)
        return f"\ue000{len(kept) - 1}\ue001"

    def code(match: re.Match[str]) -> str:
        inner = match.group(2)
        if len(inner) > 1 and inner.startswith(" ") and inner.endswith(" ") and inner.strip():
            inner = inner[1:-1]
        return keep(inner)

    text = _CODE.sub(code, text)
    text = _ESCAPE.sub(lambda m: keep(m.group(1)), text)
    text = _IMAGE.sub(lambda m: keep(picture), text)
    text = _LINK.sub(lambda m: m.group(1) or keep(m.group(2)), text)
    text = _AUTOLINK.sub(lambda m: keep(m.group(1).removeprefix("mailto:")), text)
    for mark in _MARKS:
        before = None
        while before != text:
            before = text
            text = mark.sub(r"\1", text)
    while "\ue000" in text:
        text = re.sub(r"\ue000(\d+)\ue001", lambda m: kept[int(m.group(1))], text)
    return text


def plain(notes: str, language: str = "de") -> str:
    """The note without Markdown, for search, notifications and previews."""
    picture = PICTURE.get((language or "")[:2], PICTURE["en"])
    out: list[str] = []
    fence: str | None = None
    for line in notes.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if fence is not None:
            opened = _FENCE.match(line)
            if opened and opened.group(1)[0] == fence[0] and len(opened.group(1)) >= len(fence) \
                    and not line.strip().lstrip(fence[0]):
                fence = None
            else:
                out.append(line.rstrip())
            continue
        opened = _FENCE.match(line)
        if opened:
            fence = opened.group(1)
            continue
        while _QUOTE.match(line):
            line = _QUOTE.sub("", line, count=1)
        if _BREAK.match(line) or _SETEXT.match(line):
            out.append("")
            continue
        if _HEADING.match(line):
            line = _HEADING_END.sub("", _HEADING.sub("", line, count=1))
        listed = _LIST.match(line)
        if listed:
            line = line[listed.end():]
            task = _TASK.match(line)
            if task:
                line = ("☐ " if task.group(1) == " " else "☑ ") + line[task.end():]
        line = _inline(line.strip(), picture)
        line = line.removesuffix("\\")
        out.append(line.rstrip())
    joined = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", joined).strip()
