"""nextasks among the other nex apps (shared module ``vendor/nexverbinden``, verbinden 0.2.1): its ``AppConfig``, the
``Store`` over its tables (``models_connect.py``) and the hook ``about``.

nextasks is a host in six pairs of the catalog (V2): nexnotes, nexmail, nextime, nexpaper and nexdiary use its tasks;
it uses nothing of theirs. What it grants (V5): ``tasks.read``, ``tasks.write``, ``tasks.complete`` and
``members.read``, each limited to the spaces the account gives. A partner reaches ``/api/v1`` with the token of its
connection (``ntc_``) and the same checks as an API key there, plus the purposes (``routers/v1.py``). Since 0.1.13
(V51) nexfolk asks with ``tasks.about`` how many open tasks concern the contact it shows (``about``), only at
``/api/connect/about/tasks.about``, never at ``/api/v1``.

**Older connections notice nothing.** Other apps typed in an ``ntk_`` API key of nextasks (nexnotes ``PUT
/api/nextasks``, nexmail ``POST /api/aufgabenziele/nextasks``, nextime ``PUT /api/nextasks``); such a key keeps working
at ``/api/v1`` as before. nextasks itself never typed in a key of another app, so it has no older connection of its own
to show (``legacy`` is empty). After a partner connected anew, it brings the older key to ``/api/connect/retire`` and
the key ends itself (``retire_key``).
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import __version__
from ..models import Account, ApiToken
from ..models_connect import Connection as ConnectionRow
from ..models_connect import ConnectionCode, ConnectionPending, ConnectionSpent, ConnectionWaiting
from ..security import decrypt_secret, encrypt_secret
from ..vendor import nexverbinden
from ..vendor.nexverbinden import Code, Connection, Legacy, Pending, Waiting
from . import apitokens, gone, records, settings_service, totp
from .schluessel_store import SchluesselStore

logger = logging.getLogger("nextasks.connect")

#: The tokens nextasks gives its partners: access, refresh, code. Never ``ntk_`` (an API key's).
ACCESS_PREFIX = "ntc_"
REFRESH_PREFIX = "ntcr_"
CODE_PREFIX = "ntco_"

CONFIG = nexverbinden.AppConfig(
    app_name="nextasks",
    version=__version__,
    access_prefix=ACCESS_PREFIX,
    refresh_prefix=REFRESH_PREFIX,
    code_prefix=CODE_PREFIX,
    # V20: the partners nextasks has a use for, all as host: five use its purposes at /api/v1, nexfolk asks about a
    # person at /api/connect/about/tasks.about (verbinden 0.1.13, ``about``).
    in_use=("nexnotes", "nexmail", "nextime", "nexpaper", "nexdiary", "nexfolk"),
)

#: The module's settings under nextasks' names (``settings_service.DEFAULTS``).
SETTINGS = {"connections": "connections_enabled", "addresses": "connections_addresses",
            "connections_local_network": "connections_local_network", "suggestions": "connections_suggestions"}
#: What a sealed secret of a connection is bound to (``security.encrypt_secret``).
SEAL = "nexverbinden"


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class VerbindenStore:
    """``nexverbinden.Store`` over the tables of ``models_connect``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- connections ---------------------------------------------------------------------------------------------

    @staticmethod
    def _connection(row: ConnectionRow | None) -> Connection | None:
        if row is None:
            return None
        return Connection(
            id=row.id, account_id=row.account_id, partner=row.partner, partner_base=row.partner_base,
            partner_account=row.partner_account, uses=tuple(row.uses or ()), grants=tuple(row.grants or ()),
            areas_granted=row.areas_granted, areas_used=row.areas_used, held=row.held,
            issued_access_hash=row.issued_access_hash, issued_refresh_hash=row.issued_refresh_hash,
            issued_access_expires=_aware(row.issued_access_expires) or datetime.now(UTC),
            created_at=_aware(row.created_at) or datetime.now(UTC), used_at=_aware(row.used_at),
            ok_at=_aware(row.ok_at), state=row.state, stale_since=_aware(row.stale_since), problem=row.problem,
            partner_version=row.partner_version or "",
        )

    def connections(self, account_id: Any) -> list[Connection]:
        rows = self.db.scalars(select(ConnectionRow).where(ConnectionRow.account_id == int(account_id))
                               .order_by(ConnectionRow.partner))
        return [found for row in rows if (found := self._connection(row)) is not None]

    def connection(self, account_id: Any, partner: str) -> Connection | None:
        return self._connection(self.db.scalar(select(ConnectionRow).where(
            ConnectionRow.account_id == int(account_id), ConnectionRow.partner == partner)))

    def by_issued_access(self, token_hash: str) -> Connection | None:
        return self._connection(self.db.scalar(select(ConnectionRow).where(
            ConnectionRow.issued_access_hash == token_hash)))

    def by_issued_refresh(self, token_hash: str) -> Connection | None:
        return self._connection(self.db.scalar(select(ConnectionRow).where(
            ConnectionRow.issued_refresh_hash == token_hash)))

    def save(self, connection: Connection) -> None:
        """Writes the connection (a new one replaces an older one of the same account and partner)."""
        row = self.db.get(ConnectionRow, connection.id)
        if row is None:
            self.db.execute(delete(ConnectionRow).where(ConnectionRow.account_id == int(connection.account_id),
                                                        ConnectionRow.partner == connection.partner))
            self.db.flush()
            row = ConnectionRow(id=connection.id)
            self.db.add(row)
        row.account_id = int(connection.account_id)
        row.partner = connection.partner
        row.partner_base = connection.partner_base
        row.partner_account = connection.partner_account
        row.uses = list(connection.uses)
        row.grants = list(connection.grants)
        row.areas_granted = connection.areas_granted
        row.areas_used = connection.areas_used
        row.held = connection.held
        row.issued_access_hash = connection.issued_access_hash
        row.issued_refresh_hash = connection.issued_refresh_hash
        row.issued_access_expires = connection.issued_access_expires
        row.created_at = connection.created_at
        row.used_at = connection.used_at
        row.ok_at = connection.ok_at
        row.state = connection.state
        row.stale_since = connection.stale_since
        row.problem = connection.problem
        row.partner_version = connection.partner_version
        self.db.flush()

    def remove(self, connection_id: str) -> None:
        self.db.execute(delete(ConnectionRow).where(ConnectionRow.id == connection_id))
        self.db.execute(delete(ConnectionSpent).where(ConnectionSpent.connection_id == connection_id))
        self.db.flush()

    # --- started connections and codes ---------------------------------------------------------------------------

    def add_pending(self, pending: Pending) -> None:
        self.db.add(ConnectionPending(state_hash=pending.state_hash, account_id=int(pending.account_id),
                                      partner=pending.partner, partner_base=pending.partner_base,
                                      verifier=pending.verifier, areas_granted=pending.areas_granted,
                                      created_at=pending.created_at))
        self.db.flush()

    def take_pending(self, state_hash: str) -> Pending | None:
        row = self.db.get(ConnectionPending, state_hash)
        if row is None:
            return None
        found = Pending(state_hash=row.state_hash, account_id=row.account_id, partner=row.partner,
                        partner_base=row.partner_base, verifier=row.verifier, areas_granted=row.areas_granted,
                        created_at=_aware(row.created_at) or datetime.now(UTC))
        gone = self.db.execute(delete(ConnectionPending).where(ConnectionPending.state_hash == state_hash)).rowcount
        return found if gone == 1 else None

    def add_code(self, code: Code) -> None:
        self.db.add(ConnectionCode(code_hash=code.code_hash, account_id=int(code.account_id), partner=code.partner,
                                   partner_base=code.partner_base, redirect_uri=code.redirect_uri,
                                   challenge=code.challenge, areas_granted=code.areas_granted,
                                   expires_at=code.expires_at))
        self.db.flush()

    def take_code(self, code_hash: str) -> Code | None:
        row = self.db.get(ConnectionCode, code_hash)
        if row is None:
            return None
        found = Code(code_hash=row.code_hash, account_id=row.account_id, partner=row.partner,
                     partner_base=row.partner_base, redirect_uri=row.redirect_uri, challenge=row.challenge,
                     areas_granted=row.areas_granted, expires_at=_aware(row.expires_at) or datetime.now(UTC))
        gone = self.db.execute(delete(ConnectionCode).where(ConnectionCode.code_hash == code_hash)).rowcount
        return found if gone == 1 else None

    # --- spent ---------------------------------------------------------------------------------------------------

    def spend(self, connection_id: str, token_hash: str, keep: int) -> None:
        at = int(self.db.scalar(select(func.coalesce(func.max(ConnectionSpent.at), 0))) or 0) + 1
        self.db.merge(ConnectionSpent(token_hash=token_hash, connection_id=connection_id, at=at))
        self.db.flush()
        kept = self.db.scalars(select(ConnectionSpent.token_hash).where(ConnectionSpent.connection_id == connection_id)
                               .order_by(ConnectionSpent.at.desc()).limit(keep)).all()
        self.db.execute(delete(ConnectionSpent).where(ConnectionSpent.connection_id == connection_id,
                                                      ConnectionSpent.token_hash.not_in(kept)))

    def spent_by(self, token_hash: str) -> str | None:
        row = self.db.get(ConnectionSpent, token_hash)
        return None if row is None else row.connection_id

    # --- waiting revocations ---------------------------------------------------------------------------------------

    def revoke_later(self, account_id: Any, partner_base: str, sealed_token: str, now: datetime) -> None:
        self.db.add(ConnectionWaiting(account_id=None if account_id is None else int(account_id),
                                      partner_base=partner_base, token=sealed_token, since=now))
        self.db.flush()

    def waiting(self) -> list[Waiting]:
        rows = self.db.scalars(select(ConnectionWaiting).order_by(ConnectionWaiting.id))
        return [Waiting(row.id, row.partner_base, row.token, _aware(row.since) or datetime.now(UTC)) for row in rows]

    def done_waiting(self, waiting_id: Any) -> None:
        self.db.execute(delete(ConnectionWaiting).where(ConnectionWaiting.id == int(waiting_id)))

    # --- the account and the app -------------------------------------------------------------------------------------

    def account_may(self, account_id: Any) -> bool:
        """False while the account is blocked or deleted, locked after failed sign-ins, or its keys wait for a second
        factor it owes (its connections rest, E41; the lock since verbinden 0.2.1, BS5)."""
        row = self.db.get(Account, int(account_id))
        if row is None or row.shut:
            return False
        locked = _aware(row.locked_until)
        if locked is not None and locked > datetime.now(UTC):
            return False
        return not totp.setup_required(self.db, row)

    def account_name(self, account_id: Any) -> str:
        row = self.db.get(Account, int(account_id))
        return row.name if row is not None else ""

    def account_card(self, account_id: Any) -> dict[str, Any] | None:
        """Who is signed in, for the consent page (verbinden 0.1.8, B1): the shown name, the user name and the
        address of the own picture exactly as the profile and the account menu ask for it (``avatarUrl`` in the
        frontend: ``/api/avatars/<id>?v=<when it was set>``), or none. No colour: nextasks draws a person without a
        picture as the letter of the account module (``Avatar``), the module's consent page does the same."""
        row = self.db.get(Account, int(account_id))
        if row is None:
            return None
        picture = (f"/api/avatars/{row.id}?v={quote(row.avatar_at.isoformat(), safe='')}"
                   if row.avatar_at is not None else None)
        return {"name": row.display_name or row.name, "username": row.name, "picture": picture, "color": None}

    def areas(self, account_id: Any) -> list[dict[str, Any]]:
        """The spaces of the account, by name (as an API key may be given them)."""
        return [{"id": area.id, "name": area.name}
                for area in SchluesselStore(self.db).areas_of(int(account_id), "api")]

    def legacy(self, account_id: Any) -> list[Legacy]:
        # nextasks never typed in a key of another app: no older connection of its own.
        return []

    def forget_legacy(self, account_id: Any, partner: str) -> None:
        """verbinden 0.2.0 (B9, V56): nothing to end, nextasks holds no connection typed in by hand (``legacy``)."""

    def retire_key(self, token: str) -> bool:
        """An older API key (``ntk_``) a partner had typed in ends itself, as revoking it would."""
        if not token.startswith(apitokens.TOKEN_PREFIX) or len(token) > 200:
            return False
        row = self.db.scalar(select(ApiToken).where(ApiToken.token_hash == apitokens.digest(token)))
        if row is None:
            return False
        self.db.delete(row)
        self.db.flush()
        return True

    def setting(self, name: str) -> Any:
        return settings_service.get(self.db, SETTINGS[name])

    def set_setting(self, name: str, value: Any) -> None:
        settings_service.save(self.db, {SETTINGS[name]: value}, commit=False)

    def local_allowed(self) -> bool:
        return bool(settings_service.get(self.db, SETTINGS["connections_local_network"]))

    def set_local_allowed(self, on: bool) -> None:
        """Since 0.1.4 (V36): the box "Verbindungen ins eigene Netz" in "Andere nex-Apps"; the one setting
        ``local_allowed`` reads (nextasks had no switch of its own for it)."""
        settings_service.save(self.db, {SETTINGS["connections_local_network"]: bool(on)}, commit=False)

    def seal(self, text: str) -> str:
        return encrypt_secret(text, SEAL)

    def unseal(self, sealed: str) -> str:
        return decrypt_secret(sealed, SEAL)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


def on_disconnected(store: VerbindenStore, account_id: Any, partner: str) -> None:
    """V39 (0.1.4): a connection ended here, by "Zugriff beenden" or because the partner ended it. nextasks is only a
    host: what a partner made here (tasks, comments) stays, and it keeps no rows of its own about a connection, so there
    is nothing to drop; the log says it."""
    logger.info("Connection with another nex app ended partner=%s account_id=%s", partner, account_id)


#: The purpose nexfolk asks with about one person (verbinden 0.1.13, V51).
ABOUT = "tasks.about"


def _named_in(name: str) -> re.Pattern[str] | None:
    """The person's name as whole words in a title, without upper and lower case; blanks between the words may be
    any blanks."""
    words = name.split()
    if not words:
        return None
    return re.compile(r"(?<!\w)" + r"\s+".join(re.escape(word) for word in words) + r"(?!\w)", re.IGNORECASE)


def about(
    store: VerbindenStore, caller: nexverbinden.Caller, purpose: str, person: nexverbinden.Person
) -> dict[str, Any]:
    """verbinden 0.1.13 (V52): what nextasks has about ``person`` for nexfolk's "In den anderen Apps".

    **A task concerns the person** when it is open (not completed, not in the bin) in a space the account sees and the
    connection was given (``caller.areas``; all of the account's when ``None``), and either the person's name stands in
    its title as whole words (upper or lower case alike) or a member whose address counts is one of the person's mail
    addresses is assigned to it. ``count`` is how many; ``next`` the one due next (overdue first), without any due
    date the one made last, ``at`` its due date (with the time when it has one) or the day it was made; ``open`` the
    path of that task in nextasks. Never notes, never who else."""
    del purpose  # nextasks has one purpose about a person
    from . import apiread
    from .konten_store import counts

    db = store.db
    row = db.get(Account, int(caller.account_id))
    if row is None or row.shut:
        return {"count": 0, "next": None, "last": None, "open": None}
    db.expunge(row)
    if caller.areas is not None:
        row.key_spaces = frozenset(str(area) for area in caller.areas)
    sight = apiread.sight_of(db, row)
    world = apiread.World.read(db, sight)
    named = _named_in(person.name)
    mails = {mail.casefold() for mail in person.mails}
    assigned: set[int] = set()
    if mails:
        people = {person_id for task in world.tasks.values() for person_id in gone.shown(task.row.assignees)}
        if people:
            assigned = {account.id for account in db.scalars(select(Account).where(Account.id.in_(people)))
                        if counts(account) and account.email.strip().casefold() in mails}
    found = [task for task in world.tasks.values()
             if task.open and task.trashed_at is None
             and ((named is not None and named.search(task.row.title or ""))
                  or any(person_id in assigned for person_id in gone.shown(task.row.assignees)))]
    if not found:
        return {"count": 0, "next": None, "last": None, "open": None}
    due = [task for task in found if task.row.due_date]
    if due:
        first = min(due, key=apiread.World.by_due)
        at = first.row.due_date + (f"T{first.due_time}" if first.due_time else "")
    else:
        first = max(found, key=lambda task: (task.row.created_at, task.id))
        at = records.parse_stamp(first.row.created_at).astimezone(sight.zone).date().isoformat()
    return {"count": len(found), "next": {"title": first.row.title, "at": at}, "last": None,
            "open": f"/lists/{first.list_id}?task={first.id}"}


def caller(db: Session, token: str) -> nexverbinden.Caller:
    """The connection behind a token a partner brings to ``/api/v1``; ``nexverbinden.Refused`` otherwise."""
    return nexverbinden.authenticate(VerbindenStore(db), CONFIG, token, datetime.now(UTC))


def retry_waiting() -> int:
    """Revocations a partner out of reach has not heard yet, tried again (the background round calls this)."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        return nexverbinden.retry_waiting(VerbindenStore(db), CONFIG, datetime.now(UTC))


def end_all(db: Session, account_id: int) -> int:
    """The account goes for good: its connections end, the partners hear it (or later)."""
    return nexverbinden.end_all(VerbindenStore(db), CONFIG, account_id, datetime.now(UTC))
