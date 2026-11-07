# The nextasks API

Programs such as nexmail, nexdeck, Home Assistant, n8n or your own scripts use nextasks over `/api/v1`: spaces,
lists, tasks and the numbers for a dashboard. A token reads, or reads and writes.

**The promise.** What is under `/api/v1` stays as it is: new fields may come, nothing is renamed or taken away. A
change that would break a program goes to `/api/v2` beside it. Programs ignore fields they do not know.

## Switching it on

API tokens are off until the operator switches them on, under **Settings → Server → API**. Then every account makes
its own tokens under **My account → Connections**:

- A token never does more than its account, and never sees more than the spaces chosen for it. "Every space I may see,
  later ones too" has to be picked on purpose.
- A new token runs out after 90 days; 30 days, a year or never can be picked.
- **Read** fetches spaces, lists, tasks and the numbers. **Read and write** also makes, changes, ticks off and trashes
  tasks, in spaces where the account may write. Nothing under `/api/v1` deletes for good or touches members or rights.
- The token is shown once. nextasks keeps only a checksum, and the token never reaches the log.
- The operator sees every token (never the token itself) and can block one for good. A blocked or deleted account has
  no working token.

## Asking

- `Authorization: Bearer ntk_…` on every request. A request that carries an `Origin` header is refused (`403
  origin_refused`): the API is for programs, not web pages.
- JSON in and out, UTF-8. Times are ISO 8601 in UTC with `Z` (`2026-11-07T08:30:00.000Z`); a due date is a day
  (`2026-11-08`) and an optional time of day (`09:00`), in the account's time zone.
- Ids of spaces, lists, sections and tasks are UUIDs as strings; accounts have numbers.
- At most 600 requests a minute per token; more answer `429 slow_down` with `Retry-After`.
- A space, list or task the token may not see answers like one that does not exist: `404 not_found`.

**Errors** look like `{"detail": {"code": "<code>", "message": "<English text>"}}`, as in every app of the nexapps
family, plus `"fields"` inside `detail` for `422 invalid_input`.

| Status | Code | Meaning |
|---|---|---|
| 401 | `api_off` | The operator has not switched API tokens on. |
| 401 | `token_invalid` | No valid token (missing, unknown, run out, blocked). |
| 403 | `token_reads_only` | A write with a read token. |
| 403 | `not_allowed` | The account may read the space but not write in it. |
| 403 | `origin_refused` | The request came from a web page. |
| 404 | `not_found` | Not there, or not for this token. |
| 405 | `method_not_allowed` | The route has no such method. |
| 409 | `conflict` | The change does not fit the state, e.g. a parent in another list. |
| 413 | `too_large` | The body is too large. |
| 422 | `invalid_input` | A field is wrong; `fields` names them. Unknown fields in a body are wrong too. |
| 429 | `slow_down` | Too many requests; see `Retry-After`. |

## Who am I

### `GET /api/v1/me`

```json
{ "name": "robin", "display_name": "Robin", "level": "write", "time_zone": "Europe/Berlin",
  "spaces": [{"id": "…", "name": "Familie"}], "version": "0.1.0",
  "features": ["tasks", "dashboard", "external_ref"] }
```

`features` names what this server's `/api/v1` offers; a program asks for a feature before it uses it.

## Spaces and lists

### `GET /api/v1/spaces`

The spaces the token may see, by name: `{"spaces": [{"id", "name", "icon", "role": "admin"|"member",
"writable": true, "shared": true, "hidden": false}]}`. `hidden`: the account hid the space for itself (it still counts
here; a program decides whether to show it).

### `GET /api/v1/lists`

Optional `?space_id=`. `{"lists": [{"id", "space_id", "space_name", "name", "color", "icon", "writable", "hidden",
"sections": [{"id", "name"}], "open": 4}]}`, in the order the interface shows them (lists of hidden spaces at the end).
`open`: open top-level tasks outside the bin. `hidden`: its space is hidden by the account, as in `/spaces`.

## Tasks

A task as `/api/v1` shows it:

```json
{
  "id": "…", "list_id": "…", "section_id": null, "parent_id": null,
  "title": "Brot und Milch",
  "notes": "**Vollkorn**, nicht Toast", "notes_text": "Vollkorn, nicht Toast",
  "url": null,
  "due_date": "2026-11-08", "due_time": "09:00", "repeat": null,
  "flagged": false, "priority": 0, "tags": ["einkauf"],
  "assignees": [{"id": 12, "name": "mara", "display_name": "Mara"}],
  "completed": false, "completed_at": null, "completed_by": null,
  "trashed": false, "trashed_at": null,
  "subtasks": {"open": 1, "total": 2},
  "external_ref": "nexmail:<message-id>",
  "created_at": "…", "updated_at": "…",
  "link": "https://tasks.example.com/lists/…?task=…"
}
```

- `notes` is Markdown as the interface writes it; `notes_text` the same as plain text (images as `[Bild]`/`[Image]`).
- `priority`: 0 none, 1 low, 2 medium, 3 high. `repeat`: the rule, as in the interface, or null.
- `assignees` and `completed_by` name accounts as `{"id", "name", "display_name"}`; an account deleted since, or one
  that shares no space with the token's account any more, has `name` and `display_name` null (a former member).
- `trashed`: the task is in the bin, on its own or with its parent, list or space; `trashed_at` says since when.
- `updated_at`: when the server last got a change of it.
- `link` opens the task in the web interface; it needs the operator's public address and is null without it.
- `external_ref`: the program's own key, see below. Only the account that set it sees the value; for others it is null.

### `GET /api/v1/tasks`

Filters, all optional and combined with "and":

| Parameter | |
|---|---|
| `list_id`, `space_id` | Only there. |
| `state` | `open` (default), `completed`, `all`. Trashed tasks only with `include_trashed=true`. |
| `due` | `overdue`, `today`, `upcoming` (next 7 days after today), `none`; or `due_before`, `due_after` as days (the day itself not included). |
| `assigned` | `me`, or an account id. |
| `flagged` | `true`. |
| `ids` | Up to 200 ids, comma-separated, any state. Ids gone for good come back as `{"id": "…", "gone": true}`, and so do ids the token cannot see (they answer like ones that do not exist). |
| `external_ref` | The task this account made with this key, any state. |
| `updated_since` | ISO time: only tasks changed since then, any state, trashed and gone ones included. A change counts by when the server got it, not by the clock of the device that made it; a minute before the time counts too, so a task may come twice. Pass the `as_of` of the answer before. |
| `subtasks` | `true` also lists subtasks; default only top-level tasks. |
| `limit`, `cursor` | Page size (default 100, at most 500) and the `next_cursor` of the page before. |

Answer: `{"tasks": [ … ], "next_cursor": "…" | null, "as_of": "…"}`, in the order of the interface's "All" (space,
list, section, position), with a `due` filter soonest first; gone ones (`{"id", "gone": true}`) at the end, whatever
the other filters. `as_of` is the server's time when it read.

A program that keeps tasks of its own in step (nexmail) asks either for its `ids` or with `updated_since` (and then
the `as_of` of its last answer, not its own clock).

### `GET /api/v1/tasks/{id}`

One task, with `subtasks` listed: `"subtasks": {"open": 1, "total": 2, "items": [ {task}, … ]}`. A task gone for
good answers `404 not_found`, a trashed one comes with `trashed: true`.

### `POST /api/v1/tasks` (write)

```json
{ "list_id": "…", "title": "Antwort an Fenja", "notes": "…", "url": "https://…",
  "due_date": "2026-11-08", "due_time": "09:00", "priority": 2, "flagged": false, "tags": ["mail"],
  "assignees": [12], "section_id": null, "parent_id": null,
  "external_ref": "nexmail:<message-id>" }
```

Only `title` is required. Without `list_id` the task goes to the list the interface would pick for a new task (the
first list of "Privat", never one in a hidden space); with `parent_id` into the parent's list. When the token sees no
such list, the answer is `422` with `fields: ["list_id"]`. Answer `201` with the task.

**`external_ref`** (at most 200 characters) makes the call safe to repeat: when this account already made a task with
that key, the answer is `200` with that task and nothing new is made, also when it is completed or trashed; also when
two such calls come at the same moment. "One mail, one task" for nexmail; a program picks keys that are unique in its
own world, best with its name first. When the task is gone for good, its key goes with it and the next call makes a
new task; so it does when the account does not see the task any more (it left the space). A task the account sees,
but in a space this token does not, answers `409 conflict`.

`assignees` only in shared spaces and only members; `notes` follow the rules of the interface (Markdown, at most
20 000 characters; images only as attachments, which the API does not upload).

### `PATCH /api/v1/tasks/{id}` (write)

Any of `title`, `notes`, `url`, `due_date`, `due_time`, `priority`, `flagged`, `tags`, `assignees`, `list_id`,
`section_id`, and:

- `"completed": true` ticks the task off, `false` opens it again. A repeating task works as in the interface: the
  task keeps its id and moves on to its next due date, open (its subtasks open again); the occurrence ticked off
  becomes a completed copy with an id of its own. The answer is the task as it is afterwards; when it moved on, `next`
  names the id of the open occurrence (the task's own) and `completed_copy` the id of the completed copy. When the
  rule has come to its end, the task itself is completed and neither field is there.
- `"trashed": false` brings a task back from the trash.
- `null` clears a field (`due_date: null` clears the time and the repeat too).
- `list_id` moves the task, with its subtasks, to the end of that list (or of its `section_id`).

Answer: the task. Every change goes the same way as one from the interface or the app: everybody's devices see it at
once, and the same rules for simultaneous changes apply (per field, the later change wins).

### `DELETE /api/v1/tasks/{id}` (write)

Moves the task, with its subtasks, to the trash (30 days, as in the interface). Answer `204`.

## Dashboard

### `GET /api/v1/dashboard`

For a card such as nexdeck's, counted among the spaces the token may see, without hidden ones:

```json
{
  "counts": { "overdue": 1, "today": 3, "upcoming": 5, "assigned_to_me": 2, "flagged": 1, "open": 14 },
  "overdue": [ {task}, … ], "today": [ {task}, … ], "upcoming": [ {task}, … ],
  "link": "https://tasks.example.com/today",
  "time_zone": "Europe/Berlin", "as_of": "…"
}
```

Each list holds at most 10 tasks (`?limit=` up to 50), soonest first. Counted are open tasks outside the bin,
subtasks included, as the interface's tiles count them. `today` counts what is due today, `overdue` what was due
before, `upcoming` the next 7 days after today, `assigned_to_me` the open tasks assigned to the account. Days are
those of `time_zone`, the account's.

## Later

Not in `/api/v1` yet, planned: a calendar feed (ICS) of due tasks, events sent out (webhooks), attachments.
