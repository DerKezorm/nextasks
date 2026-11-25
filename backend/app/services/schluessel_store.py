"""nextasks' side of the shared key module ``vendor/nexschluessel`` (schluessel 1.0.0): the ``AppConfig`` and the
``Store`` over nextasks' own table ``api_tokens``. Nothing moves and nothing is hashed anew: a key is the
``ntk_`` token of before (its SHA-256 in ``token_hash``, its first characters in ``prefix``, ``level`` read or write,
``spaces`` the spaces it sees or none for all). Paired iPhones (``app_devices``) are no keys of the module.

The operator's switches keep their names and their defaults: ``api`` is ``api_tokens_allowed`` (off from the start),
``app`` is ``app_enabled`` and ``pairing`` is ``app_pairing_allowed`` (both on). ``/api/v1`` keeps checking a token its
own way (``services/apitokens.authenticate``: its brake per minute, its answers); the old ways of the interface
(``/api/api-tokens``, ``/api/admin/api-tokens``) stay beside the module's (``/api/connections``).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, ApiToken, Space
from ..vendor import nexschluessel
from ..vendor.nexschluessel import ALL_AREAS, Area, Holder, Key, KeyChange, KeyKind, NewKey
from . import settings_service, totp
from . import spaces as spaces_service

#: The module's names of the operator's switches, under nextasks' own settings.
SWITCHES = {"api": "api_tokens_allowed", "app": "app_enabled", "pairing": "app_pairing_allowed"}

CONFIG = nexschluessel.AppConfig(
    app_name="nextasks",
    kinds=(KeyKind(id="api", prefix="ntk_", areas=True),),
    switches=("api", "app", "pairing"),
    # The codes of 0.8.0 where the module has others, and its status of "API tokens are off" for /api/v1.
    error_codes={"too_many_keys": "too_many_tokens", "choose_areas": "choose_spaces"},
    error_status={"api_off": 401},
)


class SchluesselStore:
    """``nexschluessel.Store`` over ``api_tokens``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    @staticmethod
    def _key(row: ApiToken) -> Key:
        return Key(
            id=row.id, account_id=row.account_id, kind="api", name=row.name, right=row.level, prefix=row.prefix,
            created_at=row.created_at, last_used_at=row.last_used_at, expires_at=row.expires_at,
            blocked_at=row.blocked_at, areas=None if row.spaces is None else list(row.spaces),
        )

    def keys_of(self, account_id: int) -> list[Key]:
        rows = self.db.scalars(select(ApiToken).where(ApiToken.account_id == int(account_id))
                               .order_by(ApiToken.created_at.desc(), ApiToken.id.desc()))
        return [self._key(row) for row in rows]

    def all_keys(self) -> list[Key]:
        rows = self.db.scalars(select(ApiToken).order_by(ApiToken.account_id, ApiToken.id))
        return [self._key(row) for row in rows]

    def key(self, key_id: int) -> Key | None:
        row = self.db.get(ApiToken, int(key_id))
        return self._key(row) if row is not None else None

    def key_by_hash(self, token_hash: str) -> Key | None:
        row = self.db.scalar(select(ApiToken).where(ApiToken.token_hash == token_hash))
        return self._key(row) if row is not None else None

    def add_key(self, new: NewKey) -> Key:
        row = ApiToken(account_id=int(new.account_id), name=new.name, level=new.right, token_hash=new.token_hash,
                       prefix=new.prefix, spaces=None if new.areas is None else sorted(set(new.areas)),
                       created_at=new.created_at, expires_at=new.expires_at)
        self.db.add(row)
        self.db.flush()
        return self._key(row)

    def change_key(self, key_id: int, change: KeyChange) -> Key:
        row = self.db.get(ApiToken, int(key_id))
        assert row is not None
        if change.name is not None:
            row.name = change.name
        if change.right is not None:
            row.level = change.right
        if change.areas is not None:
            row.spaces = None if change.areas == ALL_AREAS else sorted(set(change.areas))
        self.db.flush()
        return self._key(row)

    def remove_key(self, key_id: int) -> None:
        row = self.db.get(ApiToken, int(key_id))
        if row is not None:
            self.db.delete(row)
            self.db.flush()

    def set_blocked(self, key_id: int, when: datetime | None) -> None:
        row = self.db.get(ApiToken, int(key_id))
        if row is not None:
            row.blocked_at = when
            self.db.flush()

    def touch(self, key_id: int, when: datetime) -> None:
        row = self.db.get(ApiToken, int(key_id))
        if row is not None:
            row.last_used_at = when
            self.db.flush()

    def holder(self, account_id: int) -> Holder:
        row = self.db.get(Account, int(account_id))
        if row is None:
            return Holder(id=account_id, name="", out=True)
        return Holder(id=row.id, name=row.name, display_name=row.display_name or "", out=row.shut)

    def areas_of(self, account_id: int, kind: str) -> list[Area]:
        """The spaces a token of this account reads (never by the operator's powers), by name."""
        ids = set(spaces_service.space_ids_of(self.db, int(account_id)))
        found = self.db.scalars(select(Space).where(Space.id.in_(ids))) if ids else []
        return sorted((Area(id=space.id, name=space.name) for space in found), key=lambda area: area.name.casefold())

    def keys_wait(self, account_id: int) -> bool:
        """Tokens of a password account that owes its second factor wait (no session: ``setup_required``)."""
        row = self.db.get(Account, int(account_id))
        return row is not None and totp.setup_required(self.db, row)

    def switch(self, name: str) -> bool:
        return bool(settings_service.get(self.db, SWITCHES[name]))

    def set_switch(self, name: str, on: bool) -> None:
        settings_service.save(self.db, {SWITCHES[name]: on}, commit=False)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()
