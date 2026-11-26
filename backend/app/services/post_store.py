"""nextasks' side of the shared post module ``vendor/nexpost``: the ``Store`` over the operator's settings
(``smtp_*`` as 0.8.0 kept them, the password sealed as before) and the table ``mail_outbox``, and the worker that
sends what waits.

System mail about an account (``services/kontenpost.py``): notices (a new sign-in, a new username, a changed address,
a reset second factor) go into the outbox with the request that causes it and out at once after its commit (post
1.1.0 nudges the outbox, ``run_due`` in a thread), else within a minute (the minute loop in ``main``). Mails somebody
waits for (an invitation, a link for a new password, a confirmation link, the test mail) go out at once in the
request (``deliver_now``). A mail that does not go out is tried again after 1, 5, 15, 60 and 180 minutes, then given
up.

Since post 1.1.0 there is no mailer of nextasks' own any more: the helpers at the end of this file (``configured``,
``send_letter``, ``send_invite``, ``send_test``, ``MailError``) take every system mail through the module. nextasks'
reports and events are letters of the app (``app_letters.write`` with their HTML as ``body_html`` in the module's
frame, ``services/channels.py``); their tries and the person's state per way stay in ``notify_outbox``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, event, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account, utcnow
from ..models_accounts import MailOutbox
from ..security import decrypt_secret, encrypt_secret
from ..vendor import nexpost
from ..vendor.nexpost import Letter, MailSettings, MailStatus, OutboxItem, Recipient
from . import settings_service

logger = logging.getLogger("nextasks.mail")

#: Mails that went out or were given up stay this long for the operator's page, then go.
KEEP_DAYS = 14


#: The logo in every system mail (``cid:logo``): nextasks' mail logo, the same as in its reports.
LOGO = Path(__file__).resolve().parents[1] / "assets" / "mail-logo.png"


def _logo() -> bytes | None:
    return LOGO.read_bytes() if LOGO.is_file() else None


def configure() -> None:
    """The module set up for nextasks; the outbox runs its round right after a commit that queued a mail (in a thread),
    except where nothing runs in the background (the tests: there the minute round or ``run_due`` sends)."""
    runner = None if get_settings().disable_background else run_due
    nexpost.configure(nexpost.AppConfig(app_name="nextasks", display_name="nextasks", logo=_logo(),
                                        logger_name="nextasks.mail", outbox_runner=runner))


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _moment(text: object) -> datetime | None:
    try:
        return _aware(datetime.fromisoformat(str(text))) if text else None
    except ValueError:
        return None


class PostStore:
    """``nexpost.Store`` over ``settings`` and ``mail_outbox``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self._pending: list[Callable[[], None]] = []
        self._listening = False

    def mail_settings(self) -> MailSettings:
        values = settings_service.get_all(self.db)
        return MailSettings(
            host=str(values["smtp_host"] or ""),
            port=int(values["smtp_port"] or 587),
            security=nexpost.settings.security_of(str(values["smtp_security"] or "starttls")),
            user=str(values["smtp_user"] or ""),
            password=decrypt_secret(str(values["smtp_password_enc"] or "")),
            sender=str(values["smtp_from"] or ""),
            sender_name=str(values.get("smtp_sender_name") or ""),
        )

    def save_mail_settings(self, settings: MailSettings, password: str | None) -> None:
        changes: dict[str, object] = {
            "smtp_host": settings.host,
            "smtp_port": settings.port,
            "smtp_security": settings.security,
            "smtp_user": settings.user,
            "smtp_from": settings.sender,
            "smtp_sender_name": settings.sender_name,
        }
        if password is not None:
            changes["smtp_password_enc"] = encrypt_secret(password) if password else ""
        settings_service.save(self.db, changes, commit=False)

    def _keyed(self, key: str) -> int | None:
        return self.db.scalar(select(MailOutbox.id).where(MailOutbox.key == key))

    def add_to_outbox(self, letter: Letter, now: datetime) -> int:
        if letter.key:
            held = self._keyed(letter.key)
            if held is not None:
                return held
        row = MailOutbox(letter=json.dumps(nexpost.model.letter_data(letter)), created_at=now, next_at=now,
                         key=letter.key or None)
        try:
            # Two requests with the same key at once: the unique index lets one in, the other takes its row.
            with self.db.begin_nested():
                self.db.add(row)
                self.db.flush()
        except IntegrityError:
            held = self._keyed(letter.key)
            if held is None:
                raise
            return held
        return row.id

    @staticmethod
    def _item(row: MailOutbox) -> OutboxItem:
        return OutboxItem(
            id=row.id,
            letter=nexpost.model.letter_from(json.loads(row.letter)),
            created_at=_aware(row.created_at) or utcnow(),
            next_at=_aware(row.next_at) or utcnow(),
            attempts=row.attempts,
            error=row.error,
        )

    def due(self, now: datetime, limit: int) -> list[OutboxItem]:
        rows = self.db.scalars(
            select(MailOutbox)
            .where(MailOutbox.sent_at.is_(None), MailOutbox.next_at.is_not(None), MailOutbox.next_at <= now)
            .order_by(MailOutbox.created_at, MailOutbox.id)
            .limit(limit)
        )
        return [self._item(row) for row in rows]

    def claim(self, item_id: int | str, now: datetime, until: datetime) -> bool:
        result = self.db.execute(
            update(MailOutbox)
            .where(MailOutbox.id == int(item_id), MailOutbox.sent_at.is_(None), MailOutbox.next_at.is_not(None),
                   MailOutbox.next_at <= now)
            .values(next_at=until)
        )
        return int(result.rowcount or 0) == 1

    def mark_sent(self, item_id: int | str) -> None:
        self.db.execute(update(MailOutbox).where(MailOutbox.id == int(item_id)).values(sent_at=utcnow(), next_at=None))

    def mark_failed(self, item_id: int | str, attempts: int, next_at: datetime | None, error: str) -> None:
        self.db.execute(
            update(MailOutbox).where(MailOutbox.id == int(item_id))
            .values(attempts=attempts, next_at=next_at, error=error[:500])
        )

    def note_result(self, status: MailStatus) -> None:
        settings_service.save(self.db, {
            "mail_last_ok_at": status.last_ok_at.isoformat() if status.last_ok_at else "",
            "mail_last_error": status.last_error or "",
            "mail_last_error_at": status.last_error_at.isoformat() if status.last_error_at else "",
        }, commit=False)

    def mail_status(self) -> MailStatus:
        values = settings_service.get_all(self.db)
        return MailStatus(
            last_ok_at=_moment(values.get("mail_last_ok_at")),
            last_error=str(values.get("mail_last_error") or ""),
            last_error_at=_moment(values.get("mail_last_error_at")),
        )

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()

    # --- Since post 1.1.0 ----------------------------------------------------------------------------------------
    def waiting(self) -> int:
        return int(self.db.scalar(
            select(func.count()).select_from(MailOutbox)
            .where(MailOutbox.sent_at.is_(None), MailOutbox.next_at.is_not(None))
        ) or 0)

    def on_commit(self, callback: Callable[[], None]) -> None:
        """Once, after this transaction's commit; a rollback drops it."""
        if not self._listening:
            event.listen(self.db, "after_commit", self._committed)
            event.listen(self.db, "after_soft_rollback", self._rolled_back)
            self._listening = True
        self._pending.append(callback)

    def _committed(self, session: Session) -> None:
        pending, self._pending = self._pending, []
        for callback in pending:
            callback()

    def _rolled_back(self, session: Session, previous: Any) -> None:
        if not getattr(previous, "nested", False):
            self._pending = []

    def after_attempt(self, item: OutboxItem, error: str, given_up: bool) -> None:
        """Every try of the outbox: a report or event of nextasks (key ``notify:…``) shows at the person's way of mail
        (``outbox.after_mail_attempt``)."""
        from . import outbox

        outbox.after_mail_attempt(self.db, item.letter.key or "", error, given_up)

    def recipient(self, account: object) -> Recipient | None:
        """The address that counts, the account's language (its own, then its browser's; the module's letters speak
        de, en and fr), its name, its zone."""
        from . import emailaddr

        try:
            row = self.db.get(Account, int(str(account)))
        except ValueError:
            return None
        if row is None or not row.email or not emailaddr.confirmed(row):
            return None
        language = (row.language or row.browser_language or "").split("-")[0].split("_")[0].strip().lower()
        return Recipient(row.email, language, row.display_name or row.name, row.timezone or "")


@contextmanager
def own_store() -> Iterator[PostStore]:
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield PostStore(db)


def run_due() -> int:
    """What the minute loop calls: send what is due, and forget what went out or was given up long ago."""
    from . import outbox

    with own_store() as store:
        outbox.drop_stale_mail(store.db)
        sent = nexpost.outbox.run_once(store)
        limit = utcnow() - timedelta(days=KEEP_DAYS)
        store.db.execute(delete(MailOutbox).where(MailOutbox.created_at < limit, MailOutbox.next_at.is_(None)))
        store.commit()
    return sent


# --- The doors of every system mail (post 1.1.0; nextasks' own mailer is gone) ------------------------------------


class MailError(Exception):
    """A mail that did not go out, under the codes of 0.8.0: ``mail_off`` (no mail server), ``invalid_email`` (not an
    address), ``mail_failed`` (the server did not take it)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def configured(db: Session) -> bool:
    """A mail server and a sender are set up."""
    return PostStore(db).mail_settings().configured


def mail_language(*choices: str | None) -> str:
    """The first of ``choices`` nextasks has mail texts for (``de-AT`` counts as ``de``); English otherwise."""
    from . import messages

    for choice in choices:
        code = (choice or "").split("-")[0].split("_")[0].strip().lower()
        if code in messages.WORDS:
            return code
    return "en"


def send_letter(db: Session, letter: Letter) -> None:
    """One letter at once, through the module (``outbox.deliver_now``: its logo, its codes, the result on the
    operator's page). ``MailError`` with the codes of 0.8.0."""
    store = PostStore(db)
    if not store.mail_settings().configured:
        raise MailError("mail_off", "No mail server is set up.")
    try:
        nexpost.outbox.deliver_now(store, letter)
    except nexpost.MailError as exc:
        # The reason goes to the log by its code only: an SMTP answer can quote the address or the credentials.
        logger.warning("Mail not sent code=%s", exc.code)
        if exc.code == "mail_address_invalid":
            raise MailError("invalid_email", "This is not a mail address.") from exc
        raise MailError("mail_failed", "The mail server did not take the mail.") from exc


def send_invite(db: Session, to: str, link: str, *, by: str, space: str | None, until: object = None,
                language: str = "en", days: int = 0, member: bool = False) -> None:
    """The invitation, at once, in the receiver's language, as the shared post module writes it. Into a space it names
    the space (``space``); ``member``: the address belongs to an account already, which joins with it. ``until`` is
    kept for callers of 0.8.0."""
    del until
    values: dict[str, object] = {"by": by, "valid": nexpost.letters.validity(language, days=days) if days else ""}
    if space:
        values["space"] = space
        if member:
            values["member"] = "1"
    try:
        letter = nexpost.letters.compose("invite", to, language=language, values=values, link=link)
    except nexpost.MailError as exc:
        raise MailError("invalid_email", "This is not a mail address.") from exc
    send_letter(db, letter)


def send_test(db: Session, to: str, language: str = "en") -> None:
    """The operator's test mail, at once, as the shared post module writes it (with nextasks' logo)."""
    try:
        letter = nexpost.letters.compose("test", to, language=language, values={})
    except nexpost.MailError as exc:
        raise MailError("invalid_email", "This is not a mail address.") from exc
    send_letter(db, letter)


configure()
