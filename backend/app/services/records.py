"""The things as ``/api/app/1`` sends and takes them: their fields, clock keys, checks, defaults and the form of a
``/changes`` entry (``datenmodell.md``, ``vertrag-block1.md``).

**Clock keys.** Every field has a clock of its own, keyed by its name, except the groups of a reminder: ``place``
(``list_id, section_id, parent_id, position``), ``due`` (``due_date, due_time, repeat, repeat_from``) and
``completion`` (``completed_at, completed_by``). ``id``, ``private``, ``created_by`` and ``created_at`` have none. A
change always carries all fields of its group.

**Texts** are NFC with the blanks at both ends taken away; lengths count code points.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Annotated, Any

from pydantic import PlainSerializer

from . import fractional, gleichstand, position, wiederholung

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

COLORS = ("red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink", "brown", "gray")
VIEWS = ("list", "columns")
URL_SCHEMES = ("http", "https", "mailto")
#: Unicode ``White_Space``: none of these may stand in a tag.
WHITE_SPACE = frozenset(
    "\u0009\u000a\u000b\u000c\u000d \u0085           "
    "      　"
)
MAX_TAGS = 20
MAX_ASSIGNEES = 10

PUT_KINDS = ("space", "list", "section", "reminder", "list_pref", "space_pref", "filter", "tile_pref")
KINDS = ("space", "member", "list", "section", "reminder", "attachment", "list_pref", "space_pref", "filter",
         "tile_pref")
#: The own settings of an account: nobody else ever sees them; ``id`` = the list's or the space's.
PREF_KINDS = ("list_pref", "space_pref")
#: What belongs to an account and to no space (contract 0.5): nobody else ever sees it, and it reaches only the own
#: devices. ``filter`` has an id of its own; ``tile_pref`` the fixed one of its tile.
OWN_KINDS = ("filter", "tile_pref")
#: The six built-in tiles: Today, Scheduled, All, Flagged, Assigned to me, Completed. No other id makes a ``tile_pref``.
TILE_IDS = tuple(f"00000000-0000-4000-8000-0000000000a{number}" for number in range(1, 7))
#: The longest ``rules`` of a filter, written as JSON (RFC 8785, in code points).
MAX_RULES = 4000

#: Clock key -> its fields. A field that stands alone is its own key.
GROUPS: dict[str, dict[str, tuple[str, ...]]] = {
    "space": {},
    "list": {},
    "section": {},
    "reminder": {
        "place": ("list_id", "section_id", "parent_id", "position"),
        "due": ("due_date", "due_time", "repeat", "repeat_from"),
        "completion": ("completed_at", "completed_by"),
    },
    "list_pref": {},
    "space_pref": {},
    "filter": {},
    "tile_pref": {},
}
#: The fields with a clock, alone or in a group, per kind (in the order of the data model).
CLOCKED: dict[str, tuple[str, ...]] = {
    "space": ("name", "color", "icon", "deleted_at"),
    "list": ("space_id", "name", "color", "icon", "view", "position", "deleted_at"),
    "section": ("list_id", "name", "position"),
    "reminder": (
        "list_id", "section_id", "parent_id", "position", "title", "notes", "url", "due_date", "due_time", "repeat",
        "repeat_from", "location", "flagged", "priority", "tags", "assignees", "completed_at", "completed_by",
        "deleted_at",
    ),
    "list_pref": ("show_completed", "notify_changes"),
    "space_pref": ("hidden",),
    # ``rules`` is one field with one clock: the later object wins whole, conditions are never merged one by one.
    "filter": ("name", "color", "icon", "position", "rules", "hidden"),
    "tile_pref": ("hidden",),
}
#: What only the server sets: named in ``ignored`` when sent.
SERVER_ONLY = frozenset({"created_by", "completed_by", "private", "role", "id"})
#: What must come with a new thing.
REQUIRED: dict[str, tuple[str, ...]] = {
    "space": ("name",),
    "list": ("space_id", "name", "position"),
    "section": ("list_id", "name", "position"),
    "reminder": ("list_id", "title", "position"),
    "list_pref": (),
    "space_pref": (),
    "filter": ("name", "position"),
    "tile_pref": (),
}
DEFAULTS: dict[str, dict[str, Any]] = {
    "space": {"color": "blue", "icon": "list", "deleted_at": None},
    "list": {"color": "blue", "icon": "list", "view": "list", "deleted_at": None},
    "section": {},
    "reminder": {
        "section_id": None, "parent_id": None, "notes": "", "url": None, "due_date": None, "due_time": None,
        "repeat": None, "repeat_from": "due", "location": None, "flagged": False, "priority": 0, "tags": [],
        "assignees": [], "completed_at": None, "completed_by": None, "deleted_at": None,
    },
    "list_pref": {"show_completed": False, "notify_changes": False},
    "space_pref": {"hidden": False},
    "filter": {"color": "blue", "icon": "filter", "rules": {}, "hidden": False},
    "tile_pref": {"hidden": False},
}


def key_of(kind: str, name: str) -> str:
    """The clock key of a field: its group, or its own name."""
    for group, fields in GROUPS.get(kind, {}).items():
        if name in fields:
            return group
    return name


def clock_keys(kind: str) -> list[str]:
    keys: list[str] = []
    for name in CLOCKED.get(kind, ()):
        key = key_of(kind, name)
        if key not in keys:
            keys.append(key)
    return keys


def fields_of(kind: str, key: str) -> tuple[str, ...]:
    return GROUPS.get(kind, {}).get(key, (key,))


def value_of(kind: str, key: str, data: dict[str, Any]) -> Any:
    """What the merge rule compares: a field's value, or the object of a group's fields."""
    names = fields_of(kind, key)
    if key in GROUPS.get(kind, {}):
        return {name: data.get(name) for name in names}
    return data.get(key)


# --- Checks ---------------------------------------------------------------------------------------------------------


class Invalid(ValueError):
    def __init__(self, fields: list[str]) -> None:
        super().__init__(", ".join(fields))
        self.fields = fields


def text(value: Any, low: int, high: int) -> str:
    if not isinstance(value, str):
        raise TypeError
    clean = unicodedata.normalize("NFC", value).strip()
    if not low <= len(clean) <= high:
        raise ValueError
    if "\x00" in clean:
        raise ValueError
    return clean


def is_uuid(value: Any) -> bool:
    return isinstance(value, str) and UUID.match(value) is not None


def uuid_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if not is_uuid(value):
        raise ValueError
    return value


def stamp(value: Any) -> str:
    """``YYYY-MM-DDTHH:MM:SS.sssZ``, a real moment."""
    if not isinstance(value, str) or not STAMP.match(value):
        raise ValueError
    parse_stamp(value)
    return value


def stamp_or_none(value: Any) -> str | None:
    return None if value is None else stamp(value)


def parse_stamp(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


def format_stamp(moment: datetime) -> str:
    moment = moment.astimezone(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


#: A moment in an answer, written like every time of the data model (``YYYY-MM-DDTHH:MM:SS.sssZ``). A plain
#: ``datetime`` came out with microseconds, and ``isoformat()`` with ``+00:00``; the app reads one form only.
StampOut = Annotated[datetime, PlainSerializer(format_stamp, return_type=str)]


def ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


def day(value: Any) -> str:
    if not isinstance(value, str) or not DAY.match(value):
        raise ValueError
    date.fromisoformat(value)
    return value


def _bool(value: Any) -> bool:
    if not isinstance(value, bool):
        raise TypeError
    return value


def _color(value: Any) -> str:
    if value not in COLORS:
        raise ValueError
    return str(value)


def _icon(value: Any) -> str:
    # Any name: a name the list of symbols does not know shows ``list`` (``symbole.json``).
    return text(value, 1, 64)


def valid_key(value: Any) -> bool:
    """An order key the server takes: the check of the reference (``position.is_valid_key``: what the library checks,
    plus Base62 in the fraction), and at most ``fractional.MAX_LENGTH`` characters (the column holds no more)."""
    return isinstance(value, str) and len(value) <= fractional.MAX_LENGTH and position.is_valid_key(value)


def _position(value: Any) -> str:
    if not valid_key(value):
        raise ValueError
    return str(value)


def _url(value: Any) -> str | None:
    if value is None:
        return None
    clean = text(value, 0, 2000)
    if not clean:
        return None
    scheme = clean.split(":", 1)[0].lower() if ":" in clean else ""
    if scheme not in URL_SCHEMES or any(char.isspace() or ord(char) < 0x20 for char in clean):
        raise ValueError
    return clean


def _location(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"name", "lat", "lon", "radius_m", "on"}:
        raise ValueError
    for name in ("lat", "lon", "radius_m"):
        if isinstance(value[name], bool) or not isinstance(value[name], int | float):
            raise TypeError
    if not -90 <= value["lat"] <= 90 or not -180 <= value["lon"] <= 180 or not 100 <= value["radius_m"] <= 2000:
        raise ValueError
    if value["on"] not in ("arrive", "leave"):
        raise ValueError
    return {"name": text(value["name"], 1, 200), "lat": value["lat"], "lon": value["lon"],
            "radius_m": value["radius_m"], "on": value["on"]}


def fold_tag(tag: str) -> str:
    return unicodedata.normalize("NFC", tag).lower()


def _tags(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_TAGS:
        raise ValueError
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise TypeError
        tag = unicodedata.normalize("NFC", item)
        if not 1 <= len(tag) <= 50 or "#" in tag or any(char in WHITE_SPACE for char in tag):
            raise ValueError
        folded = fold_tag(tag)
        if folded in seen:
            continue
        seen.add(folded)
        out.append(tag)
    return out


def _assignees(value: Any) -> list[int]:
    if not isinstance(value, list) or len(value) > MAX_ASSIGNEES:
        raise ValueError
    out: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise ValueError
        if item not in out:
            out.append(item)
    return out


def _priority(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 3:
        raise ValueError
    return value


def _due_time(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not TIME.match(value):
        raise ValueError
    return value


def _repeat_from(value: Any) -> str:
    if value not in ("due", "completion"):
        raise ValueError
    return str(value)


def _view(value: Any) -> str:
    if value not in VIEWS:
        raise ValueError
    return str(value)


def _rules(value: Any) -> dict[str, Any]:
    """Any object up to ``MAX_RULES`` characters written. Its conditions are not checked: the server never evaluates a
    filter, and one made by a newer app must pass unchanged."""
    if not isinstance(value, dict):
        raise TypeError
    try:
        written = gleichstand.canonical(value)
    except RecursionError as exc:
        raise ValueError from exc
    if len(written) > MAX_RULES:
        raise ValueError
    return value


CHECKS: dict[str, dict[str, Any]] = {
    "space": {"name": lambda v: text(v, 1, 80), "color": _color, "icon": _icon, "deleted_at": stamp_or_none},
    "list": {
        "space_id": uuid_or_none, "name": lambda v: text(v, 1, 80), "color": _color, "icon": _icon, "view": _view,
        "position": _position, "deleted_at": stamp_or_none,
    },
    "section": {"list_id": uuid_or_none, "name": lambda v: text(v, 1, 80), "position": _position},
    "reminder": {
        "list_id": uuid_or_none, "section_id": uuid_or_none, "parent_id": uuid_or_none, "position": _position,
        "title": lambda v: text(v, 1, 500), "notes": lambda v: text(v, 0, 20_000), "url": _url,
        "due_date": lambda v: None if v is None else day(v), "due_time": _due_time,
        "repeat": lambda v: None if v is None else str(v), "repeat_from": _repeat_from, "location": _location,
        "flagged": _bool, "priority": _priority, "tags": _tags, "assignees": _assignees,
        "completed_at": stamp_or_none, "completed_by": lambda v: v, "deleted_at": stamp_or_none,
        "created_at": stamp,
    },
    "list_pref": {"show_completed": _bool, "notify_changes": _bool},
    "space_pref": {"hidden": _bool},
    "filter": {
        "name": lambda v: text(v, 1, 80), "color": _color, "icon": _icon, "position": _position, "rules": _rules,
        "hidden": _bool,
    },
    "tile_pref": {"hidden": _bool},
}
#: Fields that may not be null.
NOT_NULL: dict[str, frozenset[str]] = {
    "list": frozenset({"space_id"}),
    "section": frozenset({"list_id"}),
    "reminder": frozenset({"list_id", "position"}),
}


@dataclass
class Incoming:
    """A ``put`` taken apart: the clean values per clock key, the clocks, what was ignored and why it failed."""

    values: dict[str, Any] = field(default_factory=dict)
    clocks: dict[str, int] = field(default_factory=dict)
    ignored: list[str] = field(default_factory=list)
    created_at: str | None = None
    #: Fields missing from a group that came in part: wrong for a change, filled with defaults when making.
    missing: list[str] = field(default_factory=list)


def take_apart(kind: str, fields: Any, clock: Any) -> Incoming:
    """Checks a ``put`` against the data model; ``Invalid`` names every field that is wrong."""
    if not isinstance(fields, dict):
        raise Invalid(["fields"])
    if not isinstance(clock, dict):
        raise Invalid(["clock"])
    out = Incoming()
    bad: list[str] = []
    checks = CHECKS[kind]
    groups = GROUPS.get(kind, {})
    for name, raw in fields.items():
        if name in SERVER_ONLY and name not in ("completed_by",):
            out.ignored.append(name)
            continue
        if name == "created_at" and kind == "reminder":
            try:
                out.created_at = stamp(raw)
            except ValueError:
                bad.append(name)
            continue
        if name == "completed_by":
            # Vertragslücke: ``completed_by`` belongs to the group ``completion`` and is one of the fields only the
            # server sets; it is named in ``ignored`` and the server fills it in (whoever made it done, null on
            # reopening).
            out.ignored.append(name)
            continue
        if name not in checks or name not in CLOCKED[kind]:
            bad.append(name)
            continue
        if raw is None and name in NOT_NULL.get(kind, frozenset()):
            bad.append(name)
            continue
        try:
            out.values[name] = checks[name](raw)
        except (ValueError, TypeError):
            bad.append(name)
    # A change carries its group whole (``completed_by`` excepted, the server fills it in). # Vertragslücke: making a
    # reminder needs only ``list_id`` and ``position`` of the group ``place``; the rest of a group that comes in part
    # gets its defaults then, only a change must carry the group whole.
    for names in groups.values():
        present = [name for name in names if name in fields]
        if present:
            out.missing.extend(name for name in names if name not in fields and name != "completed_by")
    repeat = out.values.get("repeat")
    repeat_from = out.values.get("repeat_from", "due")
    if kind == "reminder" and repeat is not None and not wiederholung.validate(repeat, repeat_from):
        bad.append("repeat")
    keys = {key_of(kind, name) for name in out.values}
    if kind == "reminder" and "completed_at" in out.values:
        keys.add("completion")
    for key in sorted(keys):
        moment = clock.get(key)
        if isinstance(moment, bool) or not isinstance(moment, int) or moment < 0 or moment > 2**53:
            bad.append(f"clock.{key}")
            continue
        out.clocks[key] = moment
    if bad:
        raise Invalid(sorted(set(bad)))
    return out


# --- Entries of /changes --------------------------------------------------------------------------------------------


def data_of(kind: str, row: Any, *, role: str | None = None, own_member: bool = False) -> dict[str, Any]:
    """All fields of the data model."""
    if kind == "space":
        return {"id": row.id, "name": row.name, "color": row.color, "icon": row.icon, "private": row.private,
                "deleted_at": row.deleted_at, "role": role}
    if kind == "member":
        return {"space_id": row.space_id, "account_id": row.account_id, "role": row.role,
                "position": row.position if own_member else None}
    if kind == "list":
        return {"id": row.id, "space_id": row.space_id, "name": row.name, "color": row.color, "icon": row.icon,
                "view": row.view, "position": row.position, "deleted_at": row.deleted_at}
    if kind == "section":
        return {"id": row.id, "list_id": row.list_id, "name": row.name, "position": row.position}
    if kind == "reminder":
        return {
            "id": row.id, "list_id": row.list_id, "section_id": row.section_id, "parent_id": row.parent_id,
            "position": row.position, "title": row.title, "notes": row.notes, "url": row.url,
            "due_date": row.due_date, "due_time": row.due_time, "repeat": row.repeat, "repeat_from": row.repeat_from,
            "location": row.location, "flagged": row.flagged, "priority": row.priority, "tags": list(row.tags or []),
            "assignees": list(row.assignees or []), "completed_at": row.completed_at,
            "completed_by": row.completed_by, "created_by": row.created_by, "created_at": row.created_at,
            "deleted_at": row.deleted_at,
        }
    if kind == "attachment":
        return {"id": row.id, "reminder_id": row.reminder_id, "name": row.name, "mime": row.mime, "size": row.size,
                "hash": row.hash, "created_by": row.created_by, "created_at": row.created_at}
    if kind == "list_pref":
        return {"id": row.list_id, "show_completed": row.show_completed, "notify_changes": row.notify_changes}
    if kind == "space_pref":
        return {"id": row.space_id, "hidden": row.hidden}
    if kind == "filter":
        return {"id": row.id, "name": row.name, "color": row.color, "icon": row.icon, "position": row.position,
                "rules": row.rules if isinstance(row.rules, dict) else {}, "hidden": row.hidden}
    if kind == "tile_pref":
        return {"id": row.tile_id, "hidden": row.hidden}
    raise ValueError(kind)


def clock_of(kind: str, row: Any) -> dict[str, int]:
    if kind in ("member", "attachment"):
        return {}
    stored = row.clock if isinstance(row.clock, dict) else {}
    return {key: int(stored.get(key, 0)) for key in clock_keys(kind)}


def entry_id(kind: str, row: Any) -> str:
    if kind == "member":
        return f"{row.space_id}:{row.account_id}"
    if kind == "list_pref":
        return row.list_id
    if kind == "space_pref":
        return row.space_id
    if kind == "tile_pref":
        return row.tile_id
    return row.id


def entry(kind: str, row: Any, cursor: int, **data_options: Any) -> dict[str, Any]:
    return {"kind": kind, "id": entry_id(kind, row), "cursor": cursor, "deleted": False,
            "data": data_of(kind, row, **data_options), "clock": clock_of(kind, row)}


def deleted_entry(kind: str, item_id: str, cursor: int) -> dict[str, Any]:
    return {"kind": kind, "id": item_id, "cursor": cursor, "deleted": True, "data": None, "clock": None}
