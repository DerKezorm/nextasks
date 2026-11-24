"""The review (``services/stats.py``, ``routers/stats.py``): numbers only from the viewer's spaces, the run of days, the
pulse of repeating tasks with skipped occurrences, the week in sentences (alone: in the second person), today per
person, the calendar year, the look through what lies about, suggestions for a list, the weekly mail."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import update

from app.db import SessionLocal
from app.models import Account, Reminder
from app.services import clock, records, reports, stats

from .sync_helpers import API, batch, make_list, make_reminder, new_id, person, private_space, put, shared_space


def ago(days: int, hour: int = 12) -> tuple[str, str]:
    """The moment ``days`` days before today at ``hour`` (UTC, the tests' zone) and its day."""
    day = clock.today() - timedelta(days=days)
    return records.format_stamp(datetime.combine(day, time(hour), tzinfo=UTC)), day.isoformat()


def done(browser: Any, reminder: str, days: int, occurrence: str | None = None, hour: int = 12) -> dict[str, Any]:
    at, on = ago(days, hour)
    [result] = batch(browser, {"type": "complete", "id": reminder, "occurrence": occurrence, "at": at, "on": on})
    assert result["ok"], result
    return result


def speak(account: Account, language: str) -> None:
    with SessionLocal() as db:
        db.execute(update(Account).where(Account.id == account.id).values(language=language))
        db.commit()


def read(browser: Any, **params: Any) -> dict[str, Any]:
    answer = browser.get("/api/stats", params=params)
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_alone_the_numbers_runs_records_and_sentences_are_the_own() -> None:
    account, anna = person("anna")
    speak(account, "de")
    _space, first = private_space(anna)
    second = make_list(anna, _space, "Garden", "a2")
    for days in (0, 1, 2, 10, 11):
        done(anna, make_reminder(anna, first, f"Task {days}"), days)
    late = make_reminder(anna, second, "Mow", due_date=ago(5)[1])
    done(anna, late, 3)
    found = read(anna)
    assert found["scope"]["alone"] is True and found["records_mine"] is None
    assert found["total"] == {"count": 4, "previous": 2, "change_pct": 100.0}
    assert len(found["heatmap"]["days"]) == 371 and found["heatmap"]["days"][-3:] == [1, 1, 1]
    assert found["streak"]["current"] == 4 and found["streak"]["done_today"] is True
    assert found["streak"]["record"] == 4 and found["streak"]["since"] == ago(3)[1]
    assert found["punctuality"] == {"on_time": 0, "late": 1, "percent": 0.0}
    assert {entry["list"]["id"]: (entry["count"], entry["share"]) for entry in found["lists"]} == {
        first: (3, 0.75), second: (1, 0.25)}
    assert sum(map(sum, found["hours"])) == 4 and found["hours"][clock.today().weekday()][12] == 1
    assert found["records"]["total"] == 6 and found["records"]["next_milestone"] == {"count": 100, "missing": 94}
    assert found["records"]["best_day"]["count"] == 1 and found["records"]["longest_streak"]["days"] == 4
    assert [entry["id"] for entry in found["people"]] == [account.id]
    sentences = found["week"]["sentences"]
    assert sentences[0].startswith("Du hast 3 Aufgaben erledigt"), sentences
    assert not any("übernommen" in sentence for sentence in sentences)
    assert found["today"]["done"] == 1


def test_only_the_viewers_spaces_count_and_a_space_in_the_bin_not_at_all() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    family = shared_space(anna, ben)
    shared = make_list(anna, family)
    done(ben, make_reminder(anna, shared, "Bread"), 0)
    done(anna, make_reminder(anna, shared, "Milk"), 0)
    ben_private, ben_list = private_space(ben)
    done(ben, make_reminder(ben, ben_list, "Ben's own"), 0)
    found = read(anna)
    assert found["total"]["count"] == 2 and found["scope"]["alone"] is False
    assert {entry["id"]: entry["count"] for entry in found["by_person"]} == {anna_account.id: 1, ben_account.id: 1}
    assert found["records_mine"]["total"] == 1
    assert read(anna, space=family)["total"]["count"] == 2
    assert anna.get("/api/stats", params={"space": ben_private}).status_code == 404
    assert read(ben)["total"]["count"] == 3
    assert put(anna, "space", family, {"deleted_at": ago(0)[0]})["ok"]
    assert read(anna)["total"]["count"] == 0 and read(ben)["total"]["count"] == 1
    assert anna.get("/api/stats", params={"space": family}).status_code == 404


def test_somebody_who_left_counts_as_a_former_member() -> None:
    _anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    family = shared_space(anna, ben)
    shared = make_list(anna, family)
    done(ben, make_reminder(anna, shared, "Bread"), 0)
    assert anna.delete(f"{API}/spaces/{family}/members/{ben_account.id}").status_code == 204
    found = read(anna)
    assert [entry["id"] for entry in found["by_person"]] == [None]
    assert found["people"][-1] == {"id": None, "name": "Former member", "me": False, "former": True}
    assert all(entry["id"] != ben_account.id for entry in found["people"])


def test_the_pulse_tells_on_time_late_and_skipped_occurrences() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    start = ago(5)[1]
    task = make_reminder(anna, first, "Feed the fish", due_date=start, repeat="FREQ=DAILY")
    done(anna, task, 5, occurrence=start)
    # Moved on by hand over two days, then done a day late.
    later = ago(2)[1]
    put(anna, "reminder", task, {"due_date": later, "due_time": None, "repeat": "FREQ=DAILY", "repeat_from": "due"})
    done(anna, task, 1, occurrence=later)
    [series] = read(anna)["pulse"]
    assert series["series_id"] == task
    assert [(slot["due_date"], slot["status"]) for slot in series["slots"]] == [
        (start, "on_time"), (ago(4)[1], "skipped"), (ago(3)[1], "skipped"), (later, "late")]
    assert series["next"] == {"due_date": ago(1)[1], "due_time": None, "overdue": True}


def test_the_week_in_sentences_compares_people_in_a_family() -> None:
    anna_account, anna = person("anna")
    _ben_account, ben = person("ben")
    family = shared_space(anna, ben)
    shared = make_list(anna, family, "Chores")
    for _ in range(3):
        done(ben, make_reminder(anna, shared, "Dishes"), 2)
    done(anna, make_reminder(anna, shared, "Bins"), 3)
    old = make_reminder(anna, shared, "Fix the bike")
    with SessionLocal() as db:
        db.execute(update(Reminder).where(Reminder.id == old).values(created_at=ago(40)[0]))
        db.commit()
    week = read(anna)["week"]
    assert week["count"] == 4 and week["strongest_day"]["count"] == 3
    assert week["long_open"][0]["title"] == "Fix the bike" and week["long_open"][0]["days"] == 40
    assert week["frequent"] == [{"title": "Dishes", "count": 3}]
    text = " ".join(week["sentences"])
    assert "4 tasks done." in text and "ben took 3 of 4 in “Chores”." in text
    assert "“Fix the bike” has been open for 40 days" in text and "Most often: Dishes." in text
    assert anna_account


def test_a_list_ticked_off_completely_is_counted() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    one = make_reminder(anna, first, "Milk", created_at=ago(4)[0])
    two = make_reminder(anna, first, "Bread", created_at=ago(4)[0])
    done(anna, one, 3)
    done(anna, two, 2)
    again = make_reminder(anna, first, "Eggs", created_at=ago(2, 13)[0])
    done(anna, again, 1)
    [emptied] = read(anna)["week"]["emptied"]
    assert emptied["times"] == 2, "after Bread and after Eggs (Eggs was made after Bread was done)"


def test_today_per_person_due_and_done() -> None:
    anna_account, anna = person("anna")
    ben_account, ben = person("ben")
    family = shared_space(anna, ben)
    shared = make_list(anna, family)
    today = clock.today().isoformat()
    make_reminder(anna, shared, "For Ben", due_date=today, assignees=[ben_account.id])
    mine = make_reminder(anna, shared, "Mine", due_date=today)
    make_reminder(anna, shared, "Late", due_date=ago(2)[1])
    done(anna, mine, 0)
    block = read(anna)["today"]
    assert (block["due"], block["due_done"], block["done"], block["overdue"]) == (2, 1, 1, 1)
    per = {entry["id"]: entry for entry in block["people"]}
    assert per[anna_account.id] == {"id": anna_account.id, "done": 1, "due": 1, "due_done": 1}
    assert per[ben_account.id] == {"id": ben_account.id, "done": 0, "due": 1, "due_done": 0}
    assert block["people"][0]["id"] == anna_account.id


def test_the_calendar_year() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    done(anna, make_reminder(anna, first, "Now"), 0)
    make_reminder(anna, first, "Open")
    year = clock.today().year
    found = read(anna, range="year", year=year)
    assert found["range"]["from"] == f"{year}-01-01" and found["range"]["to"] == f"{year}-12-31"
    block = found["year"]
    assert block["completed"] == 1 and block["created"] == 2 and sum(block["months"]) == 1
    assert block["best_month"] == clock.today().month and block["best_hour"] == 12
    assert block["top_list"]["count"] == 1
    today = clock.today()
    assert len(block["days"]) == (date(year, 12, 31) - date(year, 1, 1)).days + 1
    assert block["days"][today.timetuple().tm_yday - 1] == 1 and sum(block["days"]) == 1
    assert block["longest_streak"] == {"days": 1, "from": today.isoformat(), "to": today.isoformat()}
    assert anna.get("/api/stats", params={"range": "week", "year": year}).status_code == 422
    assert read(anna, range="month")["year"] is None


def test_review_lists_what_lies_unchanged_or_overdue_oldest_first() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    old_moment = records.ms(records.parse_stamp(ago(20)[0]))
    stale = new_id()
    assert put(anna, "reminder", stale, {"list_id": first, "title": "Attic", "position": "a1",
                                         "created_at": ago(30)[0]}, clock_ms=old_moment)["ok"]
    overdue = make_reminder(anna, first, "Tax", due_date=ago(3)[1])
    make_reminder(anna, first, "Fresh")
    answer = anna.get("/api/review")
    assert answer.status_code == 200, answer.text
    tasks = answer.json()["tasks"]
    assert [task["id"] for task in tasks] == [stale, overdue]
    assert tasks[0]["reasons"] == ["unchanged"] and tasks[0]["age_days"] == 30 and tasks[0]["unchanged_days"] == 20
    assert tasks[1]["reasons"] == ["overdue"] and tasks[1]["overdue_days"] == 3


def test_suggestions_count_titles_without_quantities_and_know_their_section() -> None:
    _account, anna = person("anna")
    _space, first = private_space(anna)
    cold = new_id()
    assert put(anna, "section", cold, {"list_id": first, "name": "Cold", "position": "a0"})["ok"]
    for days, title in ((21, "Milch"), (14, "2 Milch"), (7, "milch")):
        done(anna, make_reminder(anna, first, title, section_id=cold), days)
    for days in (10, 3):
        done(anna, make_reminder(anna, first, "Eier"), days)
    make_reminder(anna, first, "Eier")
    done(anna, make_reminder(anna, first, "Brot"), 2)
    answer = anna.get(f"/api/lists/{first}/suggestions")
    assert answer.status_code == 200, answer.text
    found = answer.json()
    [milk] = found["suggestions"]
    assert (milk["title"], milk["key"], milk["count"], milk["interval_days"], milk["section_id"]) == (
        "milch", "milch", 3, 7, cold)
    assert milk["last_days_ago"] == 7 and milk["expected"] == clock.today().isoformat()
    assert found["placement"] == {"milch": cold} and found["sections"] == [{"id": cold, "name": "Cold"}]
    assert stats.title_key("1,5 l  Hafer Drink") == "hafer drink" and stats.title_key("7") == "7"
    _ben_account, ben = person("ben")
    assert ben.get(f"/api/lists/{first}/suggestions").status_code == 404


def test_the_weekly_mail_carries_the_sentences() -> None:
    account, anna = person("anna")
    _space, first = private_space(anna)
    done(anna, make_reminder(anna, first, "Bins"), 1)
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        message = reports.weekly(db, row, base="https://tasks.example.com", today=clock.today(), now=clock.now(),
                                 unsubscribe="https://tasks.example.com/api/notify/unsubscribe/x")
    assert message is not None and "Looking back:" in message.text and "You did 1 task." in message.text
