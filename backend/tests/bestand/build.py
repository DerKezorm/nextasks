"""Builds the "Bestand" test database with the code that is checked out right now.

The test ``tests/test_bestand.py`` loads what this script wrote and checks that every way in that worked in that
version still works in the running one. That only means something if the database comes from the OLD code:

    git worktree add ../nextasks-0.8.0 v0.8.0
    cd ../nextasks-0.8.0/backend
    <venv>/python tests/bestand/build.py --target <this repo>/backend/tests/bestand

**Never rebuild it with a newer version and commit the result.** It would then describe the new schema, and the
test would prove nothing about installations that run 0.8.0 today. The script refuses to run when ``__version__`` is
not ``VERSION``; a fixture for a later version gets its own file name.

Only invented people and ``example.*`` addresses. Every random value the test must know (session cookies, device
keys, API tokens, invitation and confirmation links, the second factor, recovery codes) is made predictable by
replacing ``secrets`` in the few modules that draw them; the code paths themselves are those of the version.

**Stored as gzip'ed SQL, not as ``.db``.** ``.gitignore`` keeps databases out of the repository, and the commit hook
refuses 32+ hex characters in a text diff, which every token hash in a plain dump is.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

HERE = Path(__file__).resolve().parent
VERSION = "0.8.0"
#: The same as ``tests/conftest.py``: the second factor's seed and the provider's client secret are sealed with it.
TEST_KEY = "test-secret-key-for-the-test-run-only"
ISSUER = "https://sso.example.com"
CLIENT_ID = "nextasks-bestand"
CLIENT_PASS = "bestand-client"
SLUG = "sso"
TAB = {"X-Nextasks-Client": "tab-bestand0"}
PUBLIC = "https://tasks.example.com"


def dump_file(folder: Path = HERE) -> Path:
    return folder / f"bestand-{VERSION}.sql.gz"


def manifest_file(folder: Path = HERE) -> Path:
    return folder / f"bestand-{VERSION}.json"


def totp_seed(label: str) -> str:
    """The seed of an account's second factor in the fixture, derived instead of stored (no secret-looking value in
    Git). The same form as ``totp.generate_seed``: base32 of 20 bytes, no padding."""
    return base64.b32encode(hashlib.sha256(f"bestand-totp-{label}".encode()).digest()[:20]).decode().rstrip("=")


class FixedChance:
    """Stands in for ``secrets`` in the modules that hand out values the test must know.

    ``token_urlsafe`` returns ``bestand-<label>-<n>``, ``n`` counting every value drawn, so two values never meet and
    each says what it was for. ``choice`` walks the alphabet (recovery codes, pairing codes). Everything else is the
    real module.
    """

    def __init__(self) -> None:
        self.label = "unnamed"
        self._count = 0
        self._step = 0

    def token_urlsafe(self, nbytes: int | None = None) -> str:
        self._count += 1
        return f"bestand-{self.label}-{self._count}"

    def choice(self, sequence: Any) -> Any:
        self._step += 1
        return sequence[(self._step * 7) % len(sequence)]

    def __getattr__(self, name: str) -> Any:
        return getattr(secrets, name)


def _environment(data: Path) -> None:
    os.environ["NEXTASKS_DATA_DIR"] = str(data)
    os.environ["NEXTASKS_DISABLE_BACKGROUND"] = "1"
    os.environ["NEXTASKS_FRONTEND_DIST"] = str(data / "no-frontend")
    os.environ["NEXTASKS_MEDIA_DIR"] = str(data / "media")
    os.environ["NEXTASKS_LOCALES_DIR"] = str(data / "locales")
    os.environ["NEXTASKS_LOG_LEVEL"] = ""
    os.environ["NEXTASKS_API_DOCS"] = "false"
    os.environ["NEXTASKS_ARGON2_TIME"] = "1"
    os.environ["NEXTASKS_ARGON2_MEMORY_KIB"] = "1024"
    os.environ["NEXTASKS_ARGON2_PARALLELISM"] = "1"
    os.environ["NEXTASKS_UPDATE_URL"] = "http://127.0.0.1:9/releases/latest"
    os.environ["NEXTASKS_PUSH_RELAY"] = "http://127.0.0.1:9"
    os.environ["NEXTASKS_SECRET_KEY"] = TEST_KEY
    os.environ["NEXTASKS_SETUP_TOKEN"] = "bestand-setup"


def build(target: Path) -> None:
    data = Path(tempfile.mkdtemp(prefix="nextasks-bestand-"))
    _environment(data)
    backend = HERE.parent.parent
    sys.path.insert(0, str(backend))
    sys.path.insert(0, str(backend / "tests" / "nexoidc"))

    import oidc_fakes as fakes
    from fastapi.testclient import TestClient

    from app import __version__, security
    from app.db import SessionLocal, engine, init_db
    from app.main import app
    from app.models import Account
    from app.services import accounts, apitokens, devices, emailaddr, mailer, settings_service, spaces, totp
    from app.vendor import nexoidc
    from app.vendor.nexoidc import attempt, protocol

    if __version__ != VERSION:
        sys.exit(f"This is nextasks {__version__}; the fixture describes {VERSION}. Check out v{VERSION} first.")

    chance = FixedChance()
    for module in (security, accounts, apitokens, devices, emailaddr, totp):
        module.secrets = chance  # type: ignore[attr-defined]
    totp.generate_seed = lambda: totp_seed(chance.label)
    mailed: list[tuple[str, Any]] = []
    mailer.send_message = lambda _db, to, message, *args, **kwargs: mailed.append((to, message))

    network = fakes.Network()
    nexoidc.use_transport(network.transport())
    protocol.clear_caches()
    attempt.forget_used_states()
    fake = network.add(fakes.FakeProvider(ISSUER, client_id=CLIENT_ID, client_secret=CLIENT_PASS))

    init_db()
    with SessionLocal() as db:
        # A mail server only while the addresses are confirmed (their links are opened here); the fixture ends
        # without one, as most installations at home.
        settings_service.save(db, {"api_tokens_allowed": True, "smtp_host": "mail.example.com",
                                   "smtp_from": "tasks@example.com", "public_url": PUBLIC})

    people: list[dict[str, Any]] = []

    def browser(host: str = "198.51.100.10") -> TestClient:
        return TestClient(app, base_url=PUBLIC, headers=TAB, follow_redirects=False,
                          client=(host, 50000))

    def ok(answer: Any, *codes: int) -> Any:
        assert answer.status_code in (codes or (200,)), (answer.status_code, answer.text[:300])
        return answer

    def row_of(name: str) -> Account:
        with SessionLocal() as db:
            found = db.query(Account).filter_by(name=name).one()
            db.expunge(found)
        return found

    def confirm_address(name: str, address: str, label: str, *, open_link: bool = True) -> str:
        """The person's own address with the link 0.8.0 mails; opened unless ``open_link`` is off."""
        chance.label = label
        with SessionLocal() as db:
            found = db.query(Account).filter_by(name=name).one()
            assert emailaddr.request(db, found, address)
        token = f"{emailaddr.TOKEN_PREFIX}bestand-{label}-{chance._count}"
        assert mailed and token in str(mailed[-1][1])
        if open_link:
            with SessionLocal() as db:
                emailaddr.confirm(db, token)
        return token

    # --- The operator: setup code, password, confirmed address, second factor, manager of "Familie" -------------
    operator_pw = "Bestand-betreiber-2026"
    desk = browser()
    chance.label = "session-betreiber"
    ok(desk.post("/api/setup", json={"name": "betreiber", "password": operator_pw, "code": "bestand-setup",
                                     "language": "de"}))
    confirm_address("betreiber", "betrieb@example.com", "email-betreiber")
    chance.label = "totp-betreiber"
    seed = ok(desk.post("/api/auth/totp/begin")).json()["secret"]
    assert seed == totp_seed("totp-betreiber")
    code = totp.code_at(seed, time.time())
    codes = ok(desk.post("/api/auth/totp/confirm", json={"code": code, "password": operator_pw})).json()
    with SessionLocal() as db:
        own = db.query(Account).filter_by(name="betreiber").one()
        family = spaces.create(db, own, "Familie")
        family_id = family.id
        db.commit()
    people.append({"name": "betreiber", "password": operator_pw, "email": "betrieb@example.com",
                   "email_confirmed": True, "operator": True, "second_factor": "totp-betreiber",
                   "recovery_codes": codes["recovery_codes"], "spaces": [family_id],
                   "case": "operator, password, confirmed address, second factor, manager of a shared space"})

    ok(desk.post("/api/oidc/admin/providers", json={
        "label": "SSO", "slug": SLUG, "issuer": ISSUER, "client_id": CLIENT_ID, "client_secret": CLIENT_PASS,
        "auto_create": True}), 201)

    def invite(label: str, email: str = "") -> str:
        chance.label = label
        made = ok(desk.post("/api/invites", json={"days": 7, "email": email}), 201).json()
        return str(made["link"]).rsplit("/", 1)[1]

    def space_invite(label: str, email: str = "") -> str:
        """An invitation into "Familie" made by its manager (the app's way, no mail needed)."""
        chance.label = label
        with SessionLocal() as db:
            own = db.query(Account).filter_by(name="betreiber").one()
            _row, token = accounts.create_invite(db, own, space_id=family_id, days=7, email=email)
        return token

    def accept(token: str, name: str, password: str) -> TestClient:
        person = browser(f"198.51.100.{20 + len(people)}")
        chance.label = f"session-{name}"
        ok(person.post(f"/api/invite/{token}", json={"name": name, "password": password}))
        return person

    # --- anna: confirmed address, API token, paired iPhone, member of "Familie" by a link while signed in -------
    anna_pw = "Bestand-anna-2026"
    anna = accept(invite("invite-anna", "anna@example.com"), "anna", anna_pw)
    confirm_address("anna", "anna@example.com", "email-anna")
    ok(anna.post(f"/api/invites/{space_invite('invite-anna-familie')}/accept"))
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name="anna").one()
        chance.label = "api-anna"
        _row, api_token = apitokens.make(db, found, "Skript", "read")
        chance.label = "device-anna"
        device_key, _device = devices.make_device(db, found, "iPhone von Anna")
    people.append({"name": "anna", "password": anna_pw, "email": "anna@example.com", "email_confirmed": True,
                   "api_token": api_token, "device": device_key, "spaces": [family_id],
                   "case": "password, confirmed address, API token, paired iPhone, joined a space signed in"})

    # --- ben: new account through an invitation into "Familie", the invitation's address (never confirmed) ------
    ben_pw = "Bestand-ben-2026x"
    accept(space_invite("invite-ben", "ben@example.net"), "ben", ben_pw)
    people.append({"name": "ben", "password": ben_pw, "email": "ben@example.net", "email_confirmed": False,
                   "spaces": [family_id], "case": "account made by an invitation into a space, its address"})

    # --- carla and dora: one address; carla's from the invitation, dora's confirmed by its link ------------------
    carla_pw = "Bestand-carla-2026"
    accept(invite("invite-carla", "familie@example.org"), "carla", carla_pw)
    people.append({"name": "carla", "password": carla_pw, "email": "familie@example.org", "email_confirmed": False,
                   "shared_email": True, "case": "address shared with dora, from the invitation (not confirmed)"})
    dora_pw = "Bestand-dora-2026x"
    accept(invite("invite-dora"), "dora", dora_pw)
    confirm_address("dora", "Familie@Example.org", "email-dora")
    people.append({"name": "dora", "password": dora_pw, "email": "Familie@Example.org", "email_confirmed": True,
                   "shared_email": True, "case": "address shared with carla in other case, confirmed by its link"})

    # --- emil: no address, one waiting for its link, an open browser session --------------------------------------
    emil_pw = "Bestand-emil-2026x"
    emil = accept(invite("invite-emil"), "emil", emil_pw)
    session = emil.cookies.get(security.SESSION_COOKIE)
    assert session
    emil_link = confirm_address("emil", "emil@example.com", "email-emil", open_link=False)
    people.append({"name": "emil", "password": emil_pw, "email": "", "email_confirmed": False,
                   "pending_email": "emil@example.com", "pending_link": emil_link, "session": session,
                   "case": "password, no address, a new address waiting for its link, open browser session"})

    # --- fritz: through the provider only ---------------------------------------------------------------------------
    def through_provider(client: TestClient, person: dict[str, Any]) -> Any:
        fake.person = dict(person)
        start = ok(client.get(f"/api/oidc/{SLUG}/start"), 302, 303, 307)
        at_provider = start.headers["location"]
        path = urlsplit(fakes.query_of(at_provider)["redirect_uri"]).path
        return client.get(f"{path}?{urlencode(fake.authorize(at_provider))}")

    fritz_at_provider = {"sub": "bestand-fritz", "preferred_username": "fritz", "name": "Fritz Faber",
                         "email": "fritz@example.com", "email_verified": True}
    chance.label = "session-fritz"
    back = through_provider(browser("198.51.100.60"), fritz_at_provider)
    assert back.status_code in (302, 303) and "error" not in back.headers["location"], back.headers.get("location")
    people.append({"name": "fritz", "password": "", "email": "fritz@example.com", "email_confirmed": False,
                   "provider": fritz_at_provider, "case": "provider only, made by it, its address (not confirmed)"})

    # --- greta: password and a link to the provider -----------------------------------------------------------------
    greta_pw = "Bestand-greta-2026"
    greta = accept(invite("invite-greta", "greta@example.com"), "greta", greta_pw)
    greta_at_provider = {"sub": "bestand-greta", "preferred_username": "greta.g", "name": "Greta",
                         "email": "greta@example.com"}
    fake.person = dict(greta_at_provider)
    asked = ok(greta.post(f"/api/oidc/{SLUG}/link", json={"password": greta_pw}))
    target_url = asked.json()["url"]
    path = urlsplit(fakes.query_of(target_url)["redirect_uri"]).path
    linked = greta.get(f"{path}?{urlencode(fake.authorize(target_url))}")
    assert linked.status_code in (302, 303) and "error" not in linked.headers["location"], linked.headers.get("location")
    people.append({"name": "greta", "password": greta_pw, "email": "greta@example.com", "email_confirmed": False,
                   "provider": greta_at_provider, "case": "password and provider, the invitation's address"})

    # --- hans: blocked; jonas: a password the operator set (the only way back in 0.8.0) --------------------------
    hans_pw = "Bestand-hans-2026x"
    accept(invite("invite-hans", "hans@example.com"), "hans", hans_pw)
    ok(desk.post(f"/api/accounts/{row_of('hans').id}/block", json={"current_password": operator_pw}), 204)
    people.append({"name": "hans", "password": hans_pw, "email": "hans@example.com", "email_confirmed": False,
                   "blocked": True, "case": "blocked by the operator"})
    accept(invite("invite-jonas"), "jonas", "Bestand-jonas-alt-2026")
    jonas_pw = "Bestand-jonas-neu-2026"
    ok(desk.put(f"/api/accounts/{row_of('jonas').id}/password",
                json={"password": jonas_pw, "current_password": operator_pw}), 204)
    people.append({"name": "jonas", "password": jonas_pw, "email": "", "email_confirmed": False,
                   "case": "password set anew by the operator (0.8.0 has no link for a forgotten password)"})

    # --- ida: deleted ----------------------------------------------------------------------------------------------
    ida_pw = "Bestand-ida-2026xx"
    accept(invite("invite-ida"), "ida", ida_pw)
    ok(desk.request("DELETE", f"/api/accounts/{row_of('ida').id}", json={"current_password": operator_pw}), 204)
    deleted = {"name": "ida", "password": ida_pw, "case": "deleted by the operator: no row is left"}

    # --- Open invitations ------------------------------------------------------------------------------------------
    open_invites = [
        {"token": invite("invite-open-with", "neu@example.com"), "email": "neu@example.com", "space": None},
        {"token": invite("invite-open-without"), "email": "", "space": None},
        {"token": space_invite("invite-open-space"), "email": "", "space": family_id},
        {"token": space_invite("invite-open-space-mail", "gast@example.com"), "email": "gast@example.com",
         "space": family_id},
    ]
    join_signed_in = space_invite("invite-open-join")

    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "", "smtp_from": ""})
    engine.dispose()
    nexoidc.use_transport(None)
    _write(data / "nextasks.db", target)
    manifest = {
        "version": VERSION,
        "test_key": "tests/conftest.py (NEXTASKS_SECRET_KEY)",
        "provider": {"slug": SLUG, "issuer": ISSUER, "client_id": CLIENT_ID, "client_pass": CLIENT_PASS},
        "settings": {"two_factor_required": False, "api_tokens_allowed": True, "password_login": True,
                     "mail": "none", "public_url": PUBLIC},
        "family": family_id,
        "accounts": people,
        "deleted": deleted,
        "open_invites": open_invites,
        "join_signed_in": {"token": join_signed_in, "space": family_id, "who": "emil"},
    }
    manifest_file(target).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    shutil.rmtree(data, ignore_errors=True)
    print(f"Written: {dump_file(target)} and {manifest_file(target)}")


def _write(database: Path, target: Path) -> None:
    """The database as SQL, gzip'ed with a fixed time stamp."""
    source = sqlite3.connect(str(database))
    try:
        lines = list(source.iterdump())
    finally:
        source.close()
    text = "\n".join(lines) + "\n"
    target.mkdir(parents=True, exist_ok=True)
    with dump_file(target).open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as packed:
        packed.write(text.encode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--target", type=Path, default=HERE)
    build(parser.parse_args().target.resolve())


if __name__ == "__main__":
    main()
