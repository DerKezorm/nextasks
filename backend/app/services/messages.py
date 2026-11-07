"""Every message nextasks sends, in one place: invitation, confirming an address, test mail, the reports "My day" and
"The week", and the single events. Each is a ``channels.Message``: title, plain text, link, and HTML for mail. Later
channels take the same text.

Plain and readable: a white card on a quiet ground, the nextasks mark (on its white ground), petrol as the one accent,
links with the public address. German or English by the account's language. Everything that comes from people (names,
titles, spaces) is escaped; nothing in a message is ever read as markup.
"""

from __future__ import annotations

import html
from dataclasses import dataclass
from datetime import date

from .channels import Message

PETROL = "#38a9c4"
PETROL_TEXT = "#1f7f99"
BUTTON = "#17738a"
GROUND = "#f4f6f7"
EDGE = "#e3e8ea"
INK = "#1d2a30"
QUIET = "#5f7079"
LATE = "#c0392b"
LOGO = "logo"

WEEKDAYS = {
    "de": ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"),
    "en": ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"),
}
WEEKDAY_NAMES = {
    "de": ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"),
    "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
}
MONTHS_EN = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

WORDS: dict[str, dict[str, str]] = {
    "de": {
        "settings": "Benachrichtigungen ändern",
        "unsubscribe_daily": "„Mein Tag“ abbestellen",
        "unsubscribe_weekly": "Wochenbericht abbestellen",
        "unsubscribe_event": "Diese Mails abbestellen",
        "footer": "Diese Mail kommt von nextasks unter {host}.",
        "open": "In nextasks öffnen",
        "daily_title": "Mein Tag: {count} Aufgaben",
        "daily_title_one": "Mein Tag: 1 Aufgabe",
        "daily_heading": "Mein Tag",
        "daily_lead": "{day}. Das steht heute für dich an.",
        "overdue": "Überfällig",
        "today": "Heute fällig",
        "assigned_new": "Dir neu zugewiesen",
        "weekly_title": "Deine Woche in nextasks",
        "weekly_heading": "Die Woche",
        "weekly_lead": "Was in deinen Bereichen in den letzten sieben Tagen erledigt wurde und was in den nächsten "
                       "sieben Tagen fällig ist.",
        "done_week": "Erledigt ({count})",
        "next_week": "In den nächsten 7 Tagen fällig",
        "done_by": "erledigt von {name}",
        "for": "für {names}",
        "from": "von {name}",
        "new_from": "neu von {name}",
        "more": "und {count} weitere",
        "assigned_title": "{name} hat dir eine Aufgabe zugewiesen",
        "assigned_lead": "{name} hat dir „{title}“ zugewiesen.",
        "due_title": "Fällig: {title}",
        "due_lead": "„{title}“ ist jetzt fällig.",
        "changed_lead": "In der Liste „{list}“ hat sich etwas getan.",
        "joined_title": "{name} ist jetzt in „{space}“",
        "joined_lead": "{name} hat die Einladung angenommen und ist jetzt Mitglied im Bereich „{space}“.",
        "confirm_title": "nextasks: Mailadresse bestätigen",
        "confirm_heading": "Mailadresse bestätigen",
        "confirm_lead": "Hallo {name}, bestätige diese Adresse für dein Konto in nextasks. Erst dann schickt "
                        "nextasks dir Mails, etwa deine Berichte.",
        "confirm_button": "Adresse bestätigen",
        "confirm_runs": "Der Link gilt {hours} Stunden und einmal. Wenn du das nicht warst, ignoriere diese Mail; "
                        "dann ändert sich nichts.",
        "invite_title": "{by} lädt dich zu nextasks ein",
        "invite_where": "in den Bereich „{space}“ in nextasks",
        "invite_app": "zu nextasks",
        "invite_lead": "{by} lädt dich {where} ein. In nextasks halten Familien und kleine Gruppen ihre Aufgaben "
                       "fest.",
        "invite_button": "Einladung annehmen",
        "invite_runs": "Der Link gilt einmal, {runs}. Wenn du diese Mail nicht erwartet hast, ignoriere sie.",
        "invite_until": "bis {day}",
        "invite_days": "ein paar Tage lang",
        "test_title": "nextasks: Testmail",
        "test_lead": "Der Mailserver in nextasks funktioniert.",
    },
    "en": {
        "settings": "Change notifications",
        "unsubscribe_daily": "Unsubscribe from “My day”",
        "unsubscribe_weekly": "Unsubscribe from the weekly report",
        "unsubscribe_event": "Unsubscribe from these mails",
        "footer": "This mail comes from nextasks at {host}.",
        "open": "Open in nextasks",
        "daily_title": "My day: {count} tasks",
        "daily_title_one": "My day: 1 task",
        "daily_heading": "My day",
        "daily_lead": "{day}. This is on for you today.",
        "overdue": "Overdue",
        "today": "Due today",
        "assigned_new": "Newly assigned to you",
        "weekly_title": "Your week in nextasks",
        "weekly_heading": "The week",
        "weekly_lead": "What was done in your spaces in the last seven days, and what is due in the next seven.",
        "done_week": "Done ({count})",
        "next_week": "Due in the next 7 days",
        "done_by": "done by {name}",
        "for": "for {names}",
        "from": "from {name}",
        "new_from": "new from {name}",
        "more": "and {count} more",
        "assigned_title": "{name} assigned a task to you",
        "assigned_lead": "{name} assigned “{title}” to you.",
        "due_title": "Due: {title}",
        "due_lead": "“{title}” is due now.",
        "changed_lead": "Something happened in the list “{list}”.",
        "joined_title": "{name} is in “{space}” now",
        "joined_lead": "{name} accepted the invitation and is a member of the space “{space}” now.",
        "confirm_title": "nextasks: confirm your mail address",
        "confirm_heading": "Confirm your mail address",
        "confirm_lead": "Hello {name}, confirm this address for your account in nextasks. Only then does nextasks "
                        "send you mail, such as your reports.",
        "confirm_button": "Confirm address",
        "confirm_runs": "The link works for {hours} hours, once. If this was not you, ignore this mail; nothing "
                        "changes then.",
        "invite_title": "{by} invites you to nextasks",
        "invite_where": "to the space “{space}” in nextasks",
        "invite_app": "to nextasks",
        "invite_lead": "{by} invites you {where}, where families and small groups keep their tasks.",
        "invite_button": "Accept the invitation",
        "invite_runs": "The link works once, {runs}. If you did not expect this mail, ignore it.",
        "invite_until": "until {day}",
        "invite_days": "for a few days",
        "test_title": "nextasks test mail",
        "test_lead": "The mail server in nextasks works.",
    },
}

#: How many lines a part of a report shows; the rest is counted.
MAX_LINES = 25


def words(language: str) -> dict[str, str]:
    return WORDS.get(language, WORDS["en"])


def one_line(text: str) -> str:
    """A name or title in a subject: one line, no control characters."""
    return " ".join("".join(char if ord(char) >= 32 and ord(char) != 127 else " " for char in text).split())


def day_label(day: date, language: str) -> str:
    weekday = WEEKDAYS.get(language, WEEKDAYS["en"])[day.weekday()]
    if language == "de":
        return f"{weekday}, {day.day}.{day.month}."
    return f"{weekday}, {MONTHS_EN[day.month - 1]} {day.day}"


def long_day(day: date, language: str) -> str:
    weekday = WEEKDAY_NAMES.get(language, WEEKDAY_NAMES["en"])[day.weekday()]
    if language == "de":
        return f"{weekday}, {day.day}.{day.month}.{day.year}"
    return f"{weekday}, {MONTHS_EN[day.month - 1]} {day.day}, {day.year}"


@dataclass(frozen=True)
class Item:
    """One task as a report shows it."""

    title: str
    list_name: str
    link: str
    due_date: str | None = None
    due_time: str | None = None
    #: Who completed it (weekly report), or who it is for.
    who: str = ""
    late: bool = False


def visible(unsubscribe: str) -> str:
    """The page behind the link in the mail (it asks before it turns anything off: a link checker that opens every
    link must not unsubscribe anybody); mail programs post to the API address itself."""
    return unsubscribe.replace("/api/notify/unsubscribe/", "/unsubscribe/", 1)


# --- Drawing ---------------------------------------------------------------------------------------------------------


def _e(text: str) -> str:
    return html.escape(text, quote=True)


def _host(base: str) -> str:
    return base.split("://", 1)[-1].rstrip("/")


def _button(label: str, link: str) -> str:
    return (f'<a href="{_e(link)}" style="display:inline-block;background:{BUTTON};color:#ffffff;'
            'text-decoration:none;font-weight:600;font-size:15px;padding:10px 18px;border-radius:10px">'
            f'{_e(label)}</a>')


def _page(language: str, base: str, heading: str, body: str, *, unsubscribe: tuple[str, str] | None = None,
          settings: bool = True) -> str:
    w = words(language)
    links: list[str] = []
    if settings:
        links.append(f'<a href="{_e(base)}/account?tab=notifications" style="color:{PETROL_TEXT}">'
                     f'{_e(w["settings"])}</a>')
    if unsubscribe:
        label, link = unsubscribe
        links.append(f'<a href="{_e(link)}" style="color:{PETROL_TEXT}">{_e(label)}</a>')
    footer = " &nbsp;·&nbsp; ".join(links)
    font = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
    table = 'role="presentation" cellpadding="0" cellspacing="0"'
    return (
        f'<!doctype html>\n<html lang="{_e(language)}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light">'
        f"<title>{_e(heading)}</title></head>\n"
        f'<body style="margin:0;padding:0;background:{GROUND};font-family:{font};color:{INK}">\n'
        f'<table {table} width="100%" style="background:{GROUND}">'
        '<tr><td align="center" style="padding:24px 12px">\n'
        f'<table {table} width="100%" style="max-width:560px">\n'
        f'<tr><td style="padding:0 4px 14px 4px"><table {table}><tr>'
        f'<td style="vertical-align:middle"><img src="cid:{LOGO}" width="36" height="36" alt="" '
        'style="display:block;border:0"></td>'
        '<td style="vertical-align:middle;padding-left:10px;font-size:18px;font-weight:700;letter-spacing:-0.2px">'
        f'NEX<span style="color:{PETROL}">TASKS</span></td></tr></table></td></tr>\n'
        f'<tr><td style="background:#ffffff;border:1px solid {EDGE};border-radius:12px;padding:24px">\n'
        f'<h1 style="margin:0 0 8px 0;font-size:21px;line-height:1.3">{_e(heading)}</h1>\n{body}\n</td></tr>\n'
        f'<tr><td style="padding:14px 4px;font-size:12px;line-height:1.6;color:{QUIET}">\n'
        f'{footer}{"<br>" if footer else ""}{_e(w["footer"].format(host=_host(base)))}\n</td></tr>\n'
        "</table></td></tr></table>\n</body></html>"
    )


def _p(text: str, *, quiet: bool = False) -> str:
    color = QUIET if quiet else INK
    return f'<p style="margin:0 0 16px 0;font-size:15px;line-height:1.55;color:{color}">{_e(text)}</p>'


def _meta(item: Item, language: str) -> str:
    parts: list[str] = [item.list_name] if item.list_name else []
    if item.due_date:
        try:
            label = day_label(date.fromisoformat(item.due_date), language)
        except ValueError:
            label = item.due_date
        parts.append(f"{label} {item.due_time}" if item.due_time else label)
    if item.who:
        parts.append(item.who)
    return " · ".join(parts)


def _rows(items: list[Item], language: str, *, done: bool = False) -> str:
    shown = items[:MAX_LINES]
    rows = []
    for item in shown:
        box = (f'<div style="width:14px;height:14px;border-radius:4px;background:{PETROL};color:#fff;font-size:11px;'
               'line-height:14px;text-align:center">&#10003;</div>' if done else
               '<div style="width:12px;height:12px;border-radius:4px;border:2px solid #9fb0b8"></div>')
        meta_color = LATE if item.late else QUIET
        rows.append(
            f'<tr><td style="width:22px;vertical-align:top;padding:9px 0 9px 0">{box}</td>'
            f'<td style="padding:7px 0;border-bottom:1px solid {EDGE}">'
            f'<a href="{_e(item.link)}" style="color:{INK};text-decoration:none;font-size:15px">'
            f'{_e(item.title)}</a><div style="font-size:12px;color:{meta_color};margin-top:2px">'
            f'{_e(_meta(item, language))}</div></td></tr>'
        )
    if len(items) > MAX_LINES:
        rows.append(f'<tr><td></td><td style="padding:7px 0;font-size:13px;color:{QUIET}">'
                    f'{_e(words(language)["more"].format(count=len(items) - MAX_LINES))}</td></tr>')
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0">'
            + "".join(rows) + "</table>")


def _part(title: str, *, color: str = QUIET) -> str:
    return (f'<h2 style="margin:18px 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;'
            f'color:{color}">{_e(title)}</h2>')


def _text_rows(items: list[Item], language: str) -> list[str]:
    lines = []
    for item in items[:MAX_LINES]:
        meta = _meta(item, language)
        lines.append(f"- {item.title}" + (f" ({meta})" if meta else ""))
        lines.append(f"  {item.link}")
    if len(items) > MAX_LINES:
        lines.append("  " + words(language)["more"].format(count=len(items) - MAX_LINES))
    return lines


def _text(lead: str, parts: list[str], *, language: str, base: str, unsubscribe: tuple[str, str] | None,
          settings: bool = True) -> str:
    w = words(language)
    out = [lead, "", *parts, "", "--"]
    if settings:
        out.append(f"{w['settings']}: {base}/account?tab=notifications")
    if unsubscribe:
        out.append(f"{unsubscribe[0]}: {unsubscribe[1]}")
    out.append(w["footer"].format(host=_host(base)))
    return "\n".join(out).strip() + "\n"


# --- The messages ----------------------------------------------------------------------------------------------------


def invite(language: str, *, base: str, link: str, by: str, space: str | None, until: date | None) -> Message:
    w = words(language)
    shown = until.strftime("%d.%m.%Y" if language == "de" else "%Y-%m-%d") if until else ""
    runs = w["invite_until"].format(day=shown) if until else w["invite_days"]
    where = w["invite_where"].format(space=one_line(space)) if space else w["invite_app"]
    lead = w["invite_lead"].format(by=one_line(by), where=where)
    title = w["invite_title"].format(by=one_line(by))
    tail = w["invite_runs"].format(runs=runs)
    body = (_p(lead) + f'<p style="margin:0 0 18px 0">{_button(w["invite_button"], link)}</p>'
            + _p(tail, quiet=True))
    text = f"{lead}\n\n{w['invite_button']}:\n{link}\n\n{tail}\n"
    return Message(title=title, text=text, link=link, html=_page(language, base, title, body, settings=False),
                   language=language, inline={LOGO: "mail-logo.png"})


def confirm(language: str, *, link: str, name: str, hours: int, base: str = "") -> Message:
    w = words(language)
    base = base or link.split("/confirm-email/", 1)[0]
    lead = w["confirm_lead"].format(name=one_line(name))
    tail = w["confirm_runs"].format(hours=hours)
    body = (_p(lead) + f'<p style="margin:0 0 18px 0">{_button(w["confirm_button"], link)}</p>'
            + _p(tail, quiet=True))
    text = f"{lead}\n\n{w['confirm_button']}:\n{link}\n\n{tail}\n"
    return Message(title=w["confirm_title"], text=text, link=link,
                   html=_page(language, base, w["confirm_heading"], body, settings=False), language=language,
                   inline={LOGO: "mail-logo.png"})


def test(language: str, *, base: str) -> Message:
    w = words(language)
    body = _p(w["test_lead"])
    return Message(title=w["test_title"], text=w["test_lead"] + "\n", link=base,
                   html=_page(language, base or "nextasks", w["test_title"], body, settings=False) if base else None,
                   language=language, inline={LOGO: "mail-logo.png"} if base else {})


def daily(language: str, *, base: str, day: date, overdue: list[Item], today: list[Item], assigned: list[Item],
          unsubscribe: str) -> Message | None:
    """``None`` when there is nothing: an empty report is not sent."""
    count = len({item.link for item in (*overdue, *today, *assigned)})
    if not count:
        return None
    w = words(language)
    title = w["daily_title_one"] if count == 1 else w["daily_title"].format(count=count)
    lead = w["daily_lead"].format(day=long_day(day, language))
    body = _p(lead, quiet=True)
    text_parts: list[str] = []
    for heading, items, color in ((w["overdue"], overdue, LATE), (w["today"], today, PETROL_TEXT),
                                  (w["assigned_new"], assigned, QUIET)):
        if not items:
            continue
        body += _part(heading, color=color) + _rows(items, language)
        text_parts += [f"{heading}:", *_text_rows(items, language), ""]
    body += f'<p style="margin:6px 0 0 0">{_button(w["open"], base + "/today")}</p>'
    off = (w["unsubscribe_daily"], visible(unsubscribe))
    return Message(title=title, text=_text(lead, text_parts, language=language, base=base, unsubscribe=off),
                   link=base + "/today", html=_page(language, base, w["daily_heading"], body, unsubscribe=off),
                   unsubscribe=unsubscribe, language=language, inline={LOGO: "mail-logo.png"})


def weekly(language: str, *, base: str, done: list[Item], upcoming: list[Item], unsubscribe: str) -> Message | None:
    if not done and not upcoming:
        return None
    w = words(language)
    lead = w["weekly_lead"]
    body = _p(lead, quiet=True)
    text_parts: list[str] = []
    if done:
        heading = w["done_week"].format(count=len(done))
        body += _part(heading, color=PETROL_TEXT) + _rows(done, language, done=True)
        text_parts += [f"{heading}:", *_text_rows(done, language), ""]
    if upcoming:
        body += _part(w["next_week"]) + _rows(upcoming, language)
        text_parts += [f"{w['next_week']}:", *_text_rows(upcoming, language), ""]
    body += f'<p style="margin:6px 0 0 0">{_button(w["open"], base + "/scheduled")}</p>'
    off = (w["unsubscribe_weekly"], visible(unsubscribe))
    return Message(title=w["weekly_title"], text=_text(lead, text_parts, language=language, base=base,
                                                       unsubscribe=off),
                   link=base + "/scheduled", html=_page(language, base, w["weekly_heading"], body, unsubscribe=off),
                   unsubscribe=unsubscribe, language=language, inline={LOGO: "mail-logo.png"})


def _event(language: str, *, base: str, title: str, lead: str, item: Item | None, link: str,
           unsubscribe: str) -> Message:
    w = words(language)
    body = _p(lead)
    parts: list[str] = []
    if item is not None:
        body += _rows([item], language)
        parts = _text_rows([item], language)
    body += f'<p style="margin:6px 0 0 0">{_button(w["open"], link)}</p>'
    off = (w["unsubscribe_event"], visible(unsubscribe))
    return Message(title=title, text=_text(lead, parts, language=language, base=base, unsubscribe=off), link=link,
                   html=_page(language, base, title, body, unsubscribe=off), unsubscribe=unsubscribe,
                   language=language, inline={LOGO: "mail-logo.png"})


def assigned(language: str, *, base: str, by: str, item: Item, unsubscribe: str) -> Message:
    w = words(language)
    return _event(language, base=base, title=w["assigned_title"].format(name=one_line(by)),
                  lead=w["assigned_lead"].format(name=one_line(by), title=one_line(item.title)), item=item,
                  link=item.link, unsubscribe=unsubscribe)


def due(language: str, *, base: str, item: Item, unsubscribe: str) -> Message:
    w = words(language)
    return _event(language, base=base, title=w["due_title"].format(title=one_line(item.title)),
                  lead=w["due_lead"].format(title=one_line(item.title)), item=item, link=item.link,
                  unsubscribe=unsubscribe)


def changed(language: str, *, base: str, list_name: str, summary: str, link: str, unsubscribe: str) -> Message:
    w = words(language)
    return _event(language, base=base, title=one_line(summary),
                  lead=w["changed_lead"].format(list=one_line(list_name)), item=None, link=link,
                  unsubscribe=unsubscribe)


def joined(language: str, *, base: str, name: str, space: str, link: str, unsubscribe: str) -> Message:
    w = words(language)
    return _event(language, base=base, title=w["joined_title"].format(name=one_line(name), space=one_line(space)),
                  lead=w["joined_lead"].format(name=one_line(name), space=one_line(space)), item=None, link=link,
                  unsubscribe=unsubscribe)
