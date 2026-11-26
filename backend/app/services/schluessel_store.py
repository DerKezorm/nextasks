"""nextasks' side of the shared key module ``vendor/nexschluessel`` (schluessel 1.1.0) and of the AI tools
``vendor/nexmcp`` (mcp 1.1.0): the ``AppConfig`` and one ``Store`` for both, over nextasks' own tables.

**API keys** are the ``api_tokens`` of before. Nothing moves and nothing is hashed anew: a key is the ``ntk_`` token of
before (its SHA-256 in ``token_hash``, its first characters in ``prefix``, ``level`` read or write, ``spaces`` the
spaces it sees or none for all), and it keeps its number as its id. **MCP keys** (``ntm_``, new with mcp 1.1.0) stand
in ``mcp_keys`` (``models_mcp.py``): made by hand, or a program's after the account's consent (OAuth). Their ids are
``mcp-<number>``, so the module's routes tell the two tables apart. Paired iPhones (``app_devices``) are no keys of the
module.

The operator's switches keep their names and their defaults: ``api`` is ``api_tokens_allowed`` (off from the start),
``mcp`` is ``mcp_enabled`` (off, MCP decision 5), ``app`` is ``app_enabled`` and ``pairing`` is
``app_pairing_allowed`` (both on). ``/api/v1`` keeps checking a token its own way (``services/apitokens.authenticate``:
its brake per minute, its answers); the old ways of the interface (``/api/api-tokens``, ``/api/admin/api-tokens``)
stay beside the module's (``/api/connections``) and show API keys only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account, ApiToken, Space
from ..models_mcp import McpClient, McpCode, McpKey, McpRequest, McpSpent, McpToolRight
from ..vendor import nexschluessel
from ..vendor.nexmcp import Caller, Client, Code, Grant, Program
from ..vendor.nexmcp import Request as McpCall
from ..vendor.nexschluessel import ALL_AREAS, Area, Holder, Key, KeyChange, KeyKind, NewKey
from . import settings_service, totp
from . import spaces as spaces_service

#: The module's names of the operator's switches, under nextasks' own settings.
SWITCHES = {"api": "api_tokens_allowed", "mcp": "mcp_enabled", "app": "app_enabled", "pairing": "app_pairing_allowed"}
#: The settings of nexmcp under nextasks' names (``programs``, ``max_level``, ``blocked_tools``).
MCP_SETTINGS = {"programs": "mcp_programs", "max_level": "mcp_max_level", "blocked_tools": "mcp_blocked_tools"}

#: An MCP key made by hand, and a program's access token: the same prefix, so one check knows both.
MCP_PREFIX = "ntm_"
#: A program's refresh token and the code of a consent.
REFRESH_PREFIX = "ntmr_"
CODE_PREFIX = "ntmc_"
#: The id of an MCP key in the module's routes: ``mcp-12``.
MCP_ID = "mcp-"

CONFIG = nexschluessel.AppConfig(
    app_name="nextasks",
    kinds=(
        KeyKind(id="api", prefix="ntk_", areas=True),
        # Made by hand (MCP decision 6) or by a program's consent; read or write, spaces as API keys.
        KeyKind(id="mcp", prefix=MCP_PREFIX, areas=True, switch="mcp", programs_count=True),
    ),
    switches=("api", "mcp", "app", "pairing"),
    programs=True,
    mcp_path="/api/mcp",
    # API keys keep their numbers, MCP keys are "mcp-<number>".
    key_id=str,
    # The codes of 0.8.0 where the module has others, and its status of "API tokens are off" for /api/v1.
    error_codes={"too_many_keys": "too_many_tokens", "choose_areas": "choose_spaces"},
    error_status={"api_off": 401},
)


def split(key_id: Any) -> tuple[str, int] | None:
    """``12`` or ``"12"``: the API key 12; ``"mcp-12"``: the MCP key 12; anything else: none."""
    if isinstance(key_id, int) and not isinstance(key_id, bool):
        return "api", key_id
    text = str(key_id)
    if text.isdigit() and len(text) <= 18:
        return "api", int(text)
    number = text[len(MCP_ID):]
    if text.startswith(MCP_ID) and number.isdigit() and len(number) <= 18:
        return "mcp", int(number)
    return None


def mcp_id(number: int) -> str:
    return f"{MCP_ID}{number}"


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class SchluesselStore:
    """``nexschluessel.Store`` over ``api_tokens`` and ``mcp_keys``, and ``nexmcp.Store`` over the tables of
    ``models_mcp``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- keys (schluessel) ------------------------------------------------------------------------------------------

    @staticmethod
    def _api(row: ApiToken) -> Key:
        return Key(
            id=row.id, account_id=row.account_id, kind="api", name=row.name, right=row.level, prefix=row.prefix,
            created_at=row.created_at, last_used_at=row.last_used_at, expires_at=row.expires_at,
            blocked_at=row.blocked_at, areas=None if row.spaces is None else list(row.spaces),
        )

    @staticmethod
    def _mcp(row: McpKey) -> Key:
        return Key(
            id=mcp_id(row.id), account_id=row.account_id, kind="mcp", name=row.name, right=row.level,
            prefix=row.prefix, created_at=row.created_at, last_used_at=row.last_used_at, expires_at=row.expires_at,
            blocked_at=row.blocked_at, areas=None if row.spaces is None else list(row.spaces),
            program=row.client_id is not None,
        )

    def _row(self, key_id: Any) -> ApiToken | McpKey | None:
        found = split(key_id)
        if found is None:
            return None
        kind, number = found
        return self.db.get(ApiToken if kind == "api" else McpKey, number)

    def _as_key(self, row: ApiToken | McpKey) -> Key:
        return self._api(row) if isinstance(row, ApiToken) else self._mcp(row)

    def keys_of(self, account_id: int) -> list[Key]:
        api = self.db.scalars(select(ApiToken).where(ApiToken.account_id == int(account_id)))
        mcp = self.db.scalars(select(McpKey).where(McpKey.account_id == int(account_id)))
        found = [self._api(row) for row in api] + [self._mcp(row) for row in mcp]
        return sorted(found, key=lambda key: (_aware(key.created_at) or datetime.min.replace(tzinfo=UTC),
                                              str(key.id)), reverse=True)

    def all_keys(self) -> list[Key]:
        api = [self._api(row) for row in self.db.scalars(select(ApiToken).order_by(ApiToken.account_id, ApiToken.id))]
        mcp = [self._mcp(row) for row in self.db.scalars(select(McpKey).order_by(McpKey.account_id, McpKey.id))]
        return api + mcp

    def key(self, key_id: Any) -> Key | None:
        row = self._row(key_id)
        return self._as_key(row) if row is not None else None

    def key_by_hash(self, token_hash: str) -> Key | None:
        row = self.db.scalar(select(ApiToken).where(ApiToken.token_hash == token_hash))
        if row is not None:
            return self._api(row)
        other = self.db.scalar(select(McpKey).where(McpKey.token_hash == token_hash))
        return self._mcp(other) if other is not None else None

    def add_key(self, new: NewKey) -> Key:
        spaces = None if new.areas is None else sorted(set(new.areas))
        if new.kind == "mcp":
            row: ApiToken | McpKey = McpKey(
                account_id=int(new.account_id), name=new.name, level=new.right, token_hash=new.token_hash,
                prefix=new.prefix, spaces=spaces, created_at=new.created_at, expires_at=new.expires_at,
            )
        else:
            row = ApiToken(account_id=int(new.account_id), name=new.name, level=new.right, token_hash=new.token_hash,
                           prefix=new.prefix, spaces=spaces, created_at=new.created_at, expires_at=new.expires_at)
        self.db.add(row)
        self.db.flush()
        return self._as_key(row)

    def change_key(self, key_id: Any, change: KeyChange) -> Key:
        row = self._row(key_id)
        assert row is not None
        if change.name is not None:
            row.name = change.name
        if change.right is not None:
            row.level = change.right
        if change.areas is not None:
            row.spaces = None if change.areas == ALL_AREAS else sorted(set(change.areas))
        self.db.flush()
        return self._as_key(row)

    def remove_key(self, key_id: Any) -> None:
        found = split(key_id)
        if found is None:
            return
        kind, number = found
        if kind == "mcp":
            self.end_program(mcp_id(number))
            return
        row = self.db.get(ApiToken, number)
        if row is not None:
            self.db.delete(row)
            self.db.flush()

    def set_blocked(self, key_id: Any, when: datetime | None) -> None:
        row = self._row(key_id)
        if row is not None:
            row.blocked_at = when
            self.db.flush()

    def touch(self, key_id: Any, when: datetime) -> None:
        row = self._row(key_id)
        if row is not None:
            row.last_used_at = when
            self.db.flush()

    def holder(self, account_id: int) -> Holder:
        row = self.db.get(Account, int(account_id))
        if row is None:
            return Holder(id=account_id, name="", out=True)
        return Holder(id=row.id, name=row.name, display_name=row.display_name or "", out=row.shut)

    def areas_of(self, account_id: int, kind: str) -> list[Area]:
        """The spaces a key of this account reads (never by the operator's powers), by name."""
        ids = set(spaces_service.space_ids_of(self.db, int(account_id)))
        found = self.db.scalars(select(Space).where(Space.id.in_(ids))) if ids else []
        return sorted((Area(id=space.id, name=space.name) for space in found), key=lambda area: area.name.casefold())

    def keys_wait(self, account_id: int) -> bool:
        """Keys of a password account that owes its second factor wait (no session: ``setup_required``)."""
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

    # --- who calls /api/mcp (nexmcp) --------------------------------------------------------------------------------

    def _caller(self, key: Key, holder: Holder) -> Caller:
        row = self.db.get(Account, int(key.account_id))
        return Caller(
            key_id=key.id, key_name=key.name or "", account_id=key.account_id, account_name=holder.name,
            level=key.right, areas=key.areas, options={}, rights=self.key_rights(key.id), program=key.program,
            admin=row is not None and row.role == OPERATOR, ai_allowed=True,
        )

    def caller(self, token: str) -> Caller | None:
        """An MCP key or a program's access token, by the key module's check (prefix, hash, locked, run out, account
        blocked or deleted, second factor owed). API keys never open MCP in nextasks (no extra ``mcp``)."""
        try:
            found = nexschluessel.authenticate(self, CONFIG, token, ("mcp",))
        except nexschluessel.KeyRefused:
            return None
        return self._caller(found.key, found.holder)

    def caller_of_key(self, key_id: Any) -> Caller | None:
        key = self.key(key_id)
        if key is None or key.kind != "mcp" or key.blocked_at is not None:
            return None
        if not key.program and nexschluessel.keys.expired(key, datetime.now(UTC)):
            return None
        holder = self.holder(key.account_id)
        if holder.out or not self.account_may(key.account_id):
            return None
        return self._caller(key, holder)

    def count_keys(self, account_id: Any) -> int:
        return int(self.db.scalar(select(func.count()).select_from(McpKey)
                                  .where(McpKey.account_id == int(account_id))) or 0)

    def account_may(self, account_id: Any) -> bool:
        row = self.db.get(Account, int(account_id))
        return row is not None and not row.shut and not totp.setup_required(self.db, row)

    def ai_allowed(self, account_id: Any) -> bool:
        # nextasks has no "KI erlaubt" per account.
        return True

    def key_areas(self, account_id: Any) -> list[dict[str, Any]]:
        return [{"id": area.id, "name": area.name} for area in self.areas_of(int(account_id), "mcp")]

    def mcp_on(self) -> bool:
        return self.switch("mcp")

    def setting(self, name: str) -> Any:
        return settings_service.get(self.db, MCP_SETTINGS[name])

    def set_setting(self, name: str, value: Any) -> None:
        settings_service.save(self.db, {MCP_SETTINGS[name]: value}, commit=False)

    def key_rights(self, key_id: Any) -> dict[str, str]:
        found = split(key_id)
        if found is None or found[0] != "mcp":
            return {}
        rows = self.db.scalars(select(McpToolRight).where(McpToolRight.key_id == found[1]))
        return {row.tool: row.value for row in rows}

    def set_key_rights(self, key_id: Any, rights: dict[str, str]) -> None:
        found = split(key_id)
        if found is None or found[0] != "mcp":
            return
        self.db.execute(delete(McpToolRight).where(McpToolRight.key_id == found[1]))
        for tool, value in rights.items():
            self.db.add(McpToolRight(key_id=found[1], tool=tool, value=value))
        self.db.flush()

    # --- programs (OAuth, nexmcp) -----------------------------------------------------------------------------------

    def _client(self, row: McpClient) -> Client:
        in_use = self.db.scalar(select(McpKey.id).where(McpKey.client_id == row.id).limit(1)) is not None
        return Client(id=row.id, name=row.name, redirect_uris=tuple(row.redirect_uris or ()),
                      created_at=_aware(row.created_at) or datetime.now(UTC), last_used_at=_aware(row.last_used_at),
                      in_use=in_use)

    def add_client(self, client: Client) -> None:
        self.db.add(McpClient(id=client.id, name=client.name, redirect_uris=list(client.redirect_uris),
                              created_at=client.created_at))
        self.db.flush()

    def client(self, client_id: str) -> Client | None:
        row = self.db.get(McpClient, client_id)
        return self._client(row) if row is not None else None

    def clients(self) -> list[Client]:
        return [self._client(row) for row in self.db.scalars(select(McpClient))]

    def remove_client(self, client_id: str) -> None:
        self.db.execute(delete(McpClient).where(McpClient.id == client_id))
        self.db.flush()

    def touch_client(self, client_id: str, when: datetime) -> None:
        self.db.execute(update(McpClient).where(McpClient.id == client_id).values(last_used_at=when))

    def add_code(self, code: Code) -> None:
        self.db.add(McpCode(code_hash=code.code_hash, client_id=code.client_id, account_id=int(code.account_id),
                            redirect_uri=code.redirect_uri, challenge=code.challenge, level=code.level,
                            spaces=code.areas, extras=dict(code.options), expires_at=code.expires_at,
                            resource=code.resource))
        self.db.flush()

    def take_code(self, code_hash: str) -> Code | None:
        row = self.db.get(McpCode, code_hash)
        if row is None:
            return None
        found = Code(code_hash=row.code_hash, client_id=row.client_id, account_id=row.account_id,
                     redirect_uri=row.redirect_uri, challenge=row.challenge, level=row.level, areas=row.spaces,
                     options=dict(row.extras or {}), expires_at=_aware(row.expires_at) or datetime.now(UTC),
                     resource=row.resource or "")
        gone = self.db.execute(delete(McpCode).where(McpCode.code_hash == code_hash)).rowcount
        self.db.flush()
        return found if gone == 1 else None

    def has_program(self, account_id: Any, client_id: str) -> bool:
        return self.db.scalar(select(McpKey.id).where(McpKey.account_id == int(account_id),
                                                       McpKey.client_id == client_id).limit(1)) is not None

    def program_signed_in(self, account_id: Any, client: Client, *, level: str, areas: Any, options: dict,
                          grant: Grant, now: datetime) -> Any:
        row = self.db.scalar(select(McpKey).where(McpKey.account_id == int(account_id),
                                                  McpKey.client_id == client.id))
        if row is None:
            row = McpKey(account_id=int(account_id), name=client.name[:200], client_id=client.id, created_at=now,
                         level=level, token_hash=grant.access_hash, prefix=grant.access_prefix)
            self.db.add(row)
        row.level = level
        row.spaces = None if areas is None else sorted({str(area) for area in areas})
        row.token_hash = grant.access_hash
        row.prefix = grant.access_prefix
        row.expires_at = grant.access_expires
        row.refresh_hash = grant.refresh_hash
        row.signed_in_at = now
        row.refreshed_at = now
        self.db.flush()
        return mcp_id(row.id)

    @staticmethod
    def _program(row: McpKey | None) -> Program | None:
        if row is None or row.client_id is None:
            return None
        signed = _aware(row.signed_in_at) or _aware(row.created_at) or datetime.now(UTC)
        return Program(key_id=mcp_id(row.id), account_id=row.account_id, client_id=row.client_id,
                       signed_in_at=signed, refreshed_at=_aware(row.refreshed_at) or signed)

    def program_by_refresh(self, refresh_hash: str) -> Program | None:
        return self._program(self.db.scalar(select(McpKey).where(McpKey.refresh_hash == refresh_hash,
                                                                  McpKey.client_id.is_not(None))))

    def program_of_token(self, token_hash: str) -> Program | None:
        return self._program(self.db.scalar(select(McpKey).where(
            McpKey.client_id.is_not(None), (McpKey.refresh_hash == token_hash) | (McpKey.token_hash == token_hash))))

    def program_refreshed(self, key_id: Any, grant: Grant, now: datetime) -> None:
        row = self._row(key_id)
        if isinstance(row, McpKey):
            row.token_hash = grant.access_hash
            row.prefix = grant.access_prefix
            row.expires_at = grant.access_expires
            row.refresh_hash = grant.refresh_hash
            row.refreshed_at = now
            self.db.flush()

    def spend(self, key_id: Any, token_hash: str, keep: int) -> None:
        found = split(key_id)
        if found is None or found[0] != "mcp":
            return
        number = found[1]
        self.db.merge(McpSpent(token_hash=token_hash, key_id=number, spent_at=datetime.now(UTC)))
        self.db.flush()
        kept = self.db.scalars(select(McpSpent.token_hash).where(McpSpent.key_id == number)
                               .order_by(McpSpent.spent_at.desc()).limit(keep)).all()
        self.db.execute(delete(McpSpent).where(McpSpent.key_id == number, McpSpent.token_hash.not_in(kept)))

    def spent_by(self, token_hash: str) -> Any:
        row = self.db.get(McpSpent, token_hash)
        return None if row is None else mcp_id(row.key_id)

    def end_program(self, key_id: Any) -> None:
        """The key is gone with what it spent and its rights per tool (an MCP key by hand too); what it wrote stays,
        and so do its requests (they tell what was asked)."""
        found = split(key_id)
        if found is None or found[0] != "mcp":
            return
        self.db.execute(delete(McpSpent).where(McpSpent.key_id == found[1]))
        self.db.execute(delete(McpToolRight).where(McpToolRight.key_id == found[1]))
        self.db.execute(delete(McpKey).where(McpKey.id == found[1]))
        self.db.flush()

    def end_programs_of(self, account_id: int) -> int:
        """Blocking or deleting an account disconnects its programs, as its sessions and devices (E42); its MCP keys
        made by hand rest instead (E41: they work again after unblocking)."""
        ids = list(self.db.scalars(select(McpKey.id).where(McpKey.account_id == int(account_id),
                                                           McpKey.client_id.is_not(None))))
        for number in ids:
            self.end_program(mcp_id(number))
        return len(ids)

    # --- requests (nexmcp) ------------------------------------------------------------------------------------------

    @staticmethod
    def _request(row: McpRequest | None) -> McpCall | None:
        if row is None:
            return None
        return McpCall(
            id=row.id, account_id=row.account_id, key_id=row.key_id, key_name=row.key_name, tool=row.tool,
            arguments=row.arguments, digest=row.digest, status=row.status,
            created_at=_aware(row.created_at) or datetime.now(UTC),
            expires_at=_aware(row.expires_at) or datetime.now(UTC), decided_at=_aware(row.decided_at),
            decided_by=row.decided_by or "", result=row.result, summary=row.summary or "",
            dangerous=bool(row.dangerous),
        )

    def add_request(self, request: McpCall) -> McpCall:
        row = McpRequest(account_id=int(request.account_id), key_id=str(request.key_id), key_name=request.key_name,
                         tool=request.tool, arguments=request.arguments, digest=request.digest,
                         status=request.status, created_at=request.created_at, expires_at=request.expires_at,
                         summary=request.summary[:500], dangerous=request.dangerous)
        self.db.add(row)
        self.db.flush()
        made = self._request(row)
        assert made is not None
        return made

    def request(self, request_id: Any) -> McpCall | None:
        try:
            number = int(request_id)
        except (TypeError, ValueError):
            return None
        return self._request(self.db.get(McpRequest, number))

    def requests_of(self, account_id: Any) -> list[McpCall]:
        rows = self.db.scalars(select(McpRequest).where(McpRequest.account_id == int(account_id))
                               .order_by(McpRequest.id.desc()))
        return [found for row in rows if (found := self._request(row)) is not None]

    def count_waiting(self, account_id: Any, key_id: Any = None) -> int:
        query = select(func.count()).select_from(McpRequest).where(McpRequest.account_id == int(account_id),
                                                                    McpRequest.status == "waiting")
        if key_id is not None:
            query = query.where(McpRequest.key_id == str(key_id))
        return int(self.db.scalar(query) or 0)

    def claim(self, request_id: Any, status: str, *, now: datetime, by: str = "") -> bool:
        changed = self.db.execute(update(McpRequest).where(McpRequest.id == int(request_id),
                                                           McpRequest.status == "waiting")
                                  .values(status=status, decided_at=now, decided_by=by[:200]))
        return int(changed.rowcount or 0) == 1

    def finish(self, request_id: Any, status: str, result: str | None, now: datetime) -> None:
        self.db.execute(update(McpRequest).where(McpRequest.id == int(request_id))
                        .values(status=status, result=result, decided_at=now))

    def expire(self, now: datetime) -> int:
        changed = self.db.execute(update(McpRequest).where(McpRequest.status == "waiting",
                                                           McpRequest.expires_at <= now)
                                  .values(status="expired", decided_at=now))
        return int(changed.rowcount or 0)
