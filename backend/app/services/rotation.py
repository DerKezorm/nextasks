"""Taking turns ("Reihum", field ``rotation`` of a reminder, contract 0.9): a repeating task in a shared space goes
round the people of its ``rotation`` in their order. Exactly one of them is in charge: ``assignees`` holds that one
person, so a client that knows nothing of turns sees an ordinary assignment.

**When it counts.** ``rotation`` is a list of account ids (order = the turn, each once, members of the space only, none
in "Private"); empty means off. It works only on a repeating reminder (``repeat`` and ``due_date``) in a shared space;
elsewhere it is kept as it is and changes nothing. One person left in it: still on, it reads like a fixed assignee.

**Whose turn it is** (``whose``): the first of ``assignees`` that is in the rotation; none there, the first of the
assignees before the change that is; none either, the first of the rotation. After every write of the reminder the
server makes ``assignees`` exactly ``[that person]`` (``settle``), written with the clock ``now``.

**Moving on** (``after_completion``): whoever ticks it off had the turn; the next one after them in the rotation is in
charge of the original now. Someone ticking it off who is not in the rotation moves it one step on from whose turn it
was. The completed copy keeps whose turn it was. Only a completion that makes a copy moves on: a date passed over by
hand (the due date set forward) or ``moved_on`` (the copy of that occurrence is there already, the turn moved then)
leave it with the same person, and so does the end of a rule (the original itself is done).

**Someone leaves** (``without``): out of the rotation; was it their turn, the one after them in the old order is in
charge.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

#: The longest rotation, as many as ``assignees`` may hold.
MOST = 10


def clean(value: Any) -> list[int]:
    """The rotation as stored: a list of account ids, each once (the first stays), at most ``MOST``."""
    if not isinstance(value, list) or len(value) > MOST:
        raise ValueError
    out: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise ValueError
        if item not in out:
            out.append(item)
    return out


def active(rotation: list[int] | None, repeat: str | None, due_date: str | None, private: bool) -> bool:
    """Whether turns are taken: a rotation, a repeating reminder (``repeat`` counts only with ``due_date``), a shared
    space."""
    return bool(rotation) and bool(repeat) and bool(due_date) and not private


def whose(rotation: list[int], assignees: Iterable[int], before: Iterable[int] = ()) -> int:
    """Whose turn it is (see above). ``rotation`` must not be empty."""
    for person in assignees:
        if person in rotation:
            return person
    for person in before:
        if person in rotation:
            return person
    return rotation[0]


def next_after(rotation: list[int], person: int) -> int:
    """The one after ``person`` in the rotation (round again after the last); ``person`` must be in it."""
    return rotation[(rotation.index(person) + 1) % len(rotation)]


def after_completion(rotation: list[int], assignees: list[int], completed_by: int | None) -> int:
    """In charge of the original after a completion that made a copy."""
    current = whose(rotation, assignees)
    if completed_by is not None and completed_by in rotation:
        return next_after(rotation, completed_by)
    return next_after(rotation, current)


def without(rotation: list[int], assignees: list[int], gone: set[int], taking_turns: bool) -> tuple[list[int],
                                                                                                    list[int]]:
    """``rotation`` and ``assignees`` once ``gone`` left. While turns are taken and the person whose turn it was left,
    the next one still there after them in the old order takes it."""
    kept = [person for person in rotation if person not in gone]
    kept_assignees = [person for person in assignees if person not in gone]
    if not taking_turns or not kept:
        return kept, kept_assignees
    current = whose(rotation, assignees)
    if current not in gone:
        return kept, [current]
    start = rotation.index(current)
    for step in range(1, len(rotation)):
        candidate = rotation[(start + step) % len(rotation)]
        if candidate not in gone:
            return kept, [candidate]
    return kept, kept_assignees


def bump(row: Any, key: str, now_ms: int) -> None:
    """A clock the server writes: now, and above the one stored, so that this value is the later one."""
    clocks = dict(row.clock or {})
    clocks[key] = max(now_ms, int(clocks.get(key, 0)) + 1)
    row.clock = clocks


def settle(row: Any, private: bool, now_ms: int, before: Iterable[int] = ()) -> bool:
    """While turns are taken: ``assignees`` becomes exactly whose turn it is. Returns whether it changed."""
    rotation = list(row.rotation or [])
    if not active(rotation, row.repeat, row.due_date, private):
        return False
    wanted = [whose(rotation, list(row.assignees or []), before)]
    if list(row.assignees or []) == wanted:
        return False
    row.assignees = wanted
    bump(row, "assignees", now_ms)
    return True
