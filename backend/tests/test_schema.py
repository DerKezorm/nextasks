"""The new nextasks starts with a database of its own: a data folder of the old one (before November 2026) is refused
at start, with a sentence that says what to do, and nothing of it is touched."""

from __future__ import annotations

import pytest
from sqlalchemy import inspect, text

from app.db import OldDatabase, engine, init_db


@pytest.mark.parametrize("table", ["tasks", "task_lists", "handovers"])
def test_a_database_of_the_old_nextasks_is_refused_and_left_as_it_is(table: str) -> None:
    with engine.begin() as connection:
        connection.execute(text(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, title TEXT)'))
        connection.execute(text(f'INSERT INTO "{table}" (id, title) VALUES (1, :kept)'), {"kept": "kept"})  # noqa: S608
    try:
        with pytest.raises(OldDatabase) as refused:
            init_db()
        assert table in str(refused.value) and "NEXTASKS_DATA_DIR" in str(refused.value)
        with engine.connect() as connection:
            assert connection.execute(text(f'SELECT title FROM "{table}"')).scalar_one() == "kept"  # noqa: S608
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP TABLE "{table}"'))
    init_db()
    assert not inspect(engine).has_table(table)


def test_a_new_database_has_the_tables_of_the_data_model() -> None:
    names = set(inspect(engine).get_table_names())
    assert {"spaces", "members", "lists", "sections", "reminders", "attachments", "list_prefs", "gone", "hidden",
            "space_prefs", "filters", "tile_prefs", "sync_state", "app_devices", "app_ops"} <= names
    assert not names & {"teams", "tasks", "task_lists", "handovers", "absences", "calendar_feeds"}
