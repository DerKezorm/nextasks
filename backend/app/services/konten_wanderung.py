"""What a database of 0.8.0 needs for the shared account module beyond new columns and tables, at every start after
``db.init_db`` made those (with a backup before, ``db._add_missing_columns``). Only adding, never renaming or deleting;
a second start finds nothing to do, and 0.8.0 still runs on the result (it ignores what it does not know).

- Every session of 0.8.0 gets the id the list "Signed-in devices" names it by.
- Usernames are unique without regard to case in the database too, as the module asks (two changes at the same moment
  never both get through). 0.8.0 always wrote them in lower case, so the index fits every database it made; should a
  database hold two names that differ only in case anyway, the index is left out with a warning and the start goes on
  (both still sign in with the name written exactly).
- Addresses get an index without regard to case, **not** a unique one: 0.8.0 let two accounts hold one address (only
  one of them could confirm it), and such a pair signs in by name only (the module, rule 3 of the draft).
"""

from __future__ import annotations

import logging
import secrets

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger("nextasks.db")


def run(engine: Engine) -> None:
    with engine.begin() as connection:
        missing = [row[0] for row in connection.execute(text("SELECT id FROM auth_sessions WHERE uid IS NULL"))]
        for session_id in missing:
            connection.execute(text("UPDATE auth_sessions SET uid = :uid WHERE id = :id"),
                               {"uid": secrets.token_hex(12), "id": session_id})
        if missing:
            logger.info("Sessions of an older version named for the session list count=%s", len(missing))

        doubles = connection.execute(
            text("SELECT lower(name) FROM accounts GROUP BY lower(name) HAVING count(*) > 1")
        ).first()
        if doubles is None:
            connection.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_name_lower ON accounts (lower(name))")
            )
        else:
            logger.warning("Two accounts have names that differ only in case; the unique index waits until one is "
                           "renamed")
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_accounts_email_lower ON accounts (lower(email))"))
        # Expression indexes here, not in the model: SQLAlchemy cannot read them back and would make them twice.
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_former_names_lower ON former_names (lower(name))"))
