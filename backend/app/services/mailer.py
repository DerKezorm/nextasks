"""Mail through the operator's SMTP server.

Off until the operator enters a server: the link to copy is always enough for an invitation. What goes out: the
invitation, the operator's test mail, the link that confirms an address (``services/emailaddr.py``), and the reports
and events people chose (``services/notifyprefs.py``, sent by ``services/outbox.py``). The texts are in
``services/messages.py``. Every mail is plain text plus HTML with the nextasks mark inline; a report or event carries
``List-Unsubscribe`` with one click (RFC 8058).

Invitation and test mail go out in the language of whoever receives it (Prüfgang 05.10.2026, decision 8): the account
that has the address already, else the language of whoever invites (or tests), else the language of their page, else
English.

The last mail sent and the last failure are kept (settings ``mail_last_ok_at``, ``mail_last_error``,
``mail_last_error_at``): the operator sees them at the mail server.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from datetime import UTC, date, datetime
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from sqlalchemy.orm import Session

from ..security import decrypt_secret
from . import messages, settings_service
from .channels import Message

logger = logging.getLogger("nextasks.mail")

TIMEOUT = 15
SECURITY = ("starttls", "tls", "none")
ASSETS = Path(__file__).resolve().parent.parent / "assets"


class MailError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def configured(db: Session) -> bool:
    values = settings_service.get_all(db)
    return bool(values["smtp_host"] and values["smtp_from"])


def _note(db: Session, *, ok: bool, code: str = "") -> None:
    """The server's last mail and last failure, for the operator's page. Never lets a mail fail."""
    now = datetime.now(UTC).isoformat()
    changes = {"mail_last_ok_at": now} if ok else {"mail_last_error": code, "mail_last_error_at": now}
    try:
        settings_service.save(db, changes)
    except Exception:  # noqa: BLE001 - a busy database must not turn a sent mail into a failed one
        db.rollback()
        logger.warning("Mail state not saved")


def _send(db: Session, message: EmailMessage) -> None:
    values = settings_service.get_all(db)
    if not (values["smtp_host"] and values["smtp_from"]):
        raise MailError("mail_off", "No mail server is set up.")
    host = str(values["smtp_host"])
    port = int(values["smtp_port"])
    security = str(values["smtp_security"])
    message["From"] = str(values["smtp_from"])
    message["Message-ID"] = make_msgid(domain=str(values["smtp_from"]).rpartition("@")[2] or None)
    # Required by RFC 5322. smtplib does not add it, and without it iCloud, Outlook and Gmail drop the mail silently.
    if "Date" not in message:
        message["Date"] = formatdate(localtime=True)
    context = ssl.create_default_context()
    try:
        if security == "tls":
            server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT, context=context)
        else:
            server = smtplib.SMTP(host, port, timeout=TIMEOUT)
        with server:
            if security == "starttls":
                server.starttls(context=context)
            user = str(values["smtp_user"])
            if user:
                server.login(user, decrypt_secret(str(values["smtp_password_enc"])))
            server.send_message(message)
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        # The reason goes to the log by its kind only: an SMTP answer can quote the address or the credentials.
        logger.warning("Mail not sent host=%s reason=%s", host, type(exc).__name__)
        _note(db, ok=False, code="mail_failed")
        raise MailError("mail_failed", "The mail server did not take the mail.") from exc
    logger.info("Mail sent host=%s", host)
    _note(db, ok=True)


def build(to: str, message: Message) -> EmailMessage:
    """The mail of a finished message: text, and HTML with its pictures beside it when there is HTML."""
    mail = EmailMessage()
    mail["To"] = formataddr(("", to))
    mail["Subject"] = messages.one_line(message.title)
    mail["Content-Language"] = message.language
    if message.unsubscribe:
        # One click from the mail program (RFC 8058): a POST to this address, no sign-in, only this report or event.
        mail["List-Unsubscribe"] = f"<{message.unsubscribe}>"
        mail["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        mail["Auto-Submitted"] = "auto-generated"
    mail.set_content(message.text)
    if message.html:
        mail.add_alternative(message.html, subtype="html")
        html_part = mail.get_payload()[1]
        for cid, file_name in message.inline.items():
            data = (ASSETS / file_name).read_bytes()
            html_part.add_related(data, maintype="image", subtype="png", cid=f"<{cid}>", filename=file_name,
                                  disposition="inline")
    return mail


def send_message(db: Session, to: str, message: Message) -> None:
    _send(db, build(to, message))


def mail_language(*choices: str | None) -> str:
    """The first of ``choices`` nextasks has mail texts for (``de-AT`` counts as ``de``); English otherwise."""
    for choice in choices:
        code = (choice or "").split("-")[0].split("_")[0].strip().lower()
        if code in messages.WORDS:
            return code
    return "en"


def send_invite(db: Session, to: str, link: str, *, by: str, space: str | None, until: date | None = None,
                language: str = "en") -> None:
    base = settings_service.public_url(db)
    send_message(db, to, messages.invite(language, base=base, link=link, by=by, space=space, until=until))


def send_test(db: Session, to: str, language: str = "en") -> None:
    send_message(db, to, messages.test(language, base=settings_service.public_url(db)))
