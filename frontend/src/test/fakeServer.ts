/**
 * A stand-in for the nextasks server: `/api/app/1` after the contract (`vertrag-block1.md`), with cursors, clocks
 * per field, tombstones, rights, `complete` with repetition, files, invitations and pairing, plus the few older paths
 * the frame needs (who is signed in, settings). Tests talk to it through `fetch`; `npm run dev` with `VITE_FAKE=1`
 * puts it in front of the page instead of a real server.
 *
 * It follows the same rules as the web (`sync/merge.ts`, `sync/complete.ts`), so it proves the web keeps the
 * contract, not that a second implementation agrees; the server's own tests do that against the shared test sets.
 */
import { applyComplete, type CompleteWorld, type Stored } from '../sync/complete'
import { cleanTags, cleanText, fresh, REQUIRED, SERVER_ONLY, textLength } from '../sync/fields'
import { mergeInto } from '../sync/merge'
import { isValidKey, keyAtEnd } from '../sync/position'
import { parseRule } from '../sync/repeat'
import type { Clock, CompleteOp, Data, DeleteOp, Item, Kind, Op, PositionOp, PutOp, Result } from '../sync/types'
import { uuid4 } from '../sync/uuid'

export interface Account {
  id: number
  name: string | null
  username: string
  operator: boolean
  timezone: string
  language: string
  avatar_hash: string | null
  password: string
}

interface Row {
  kind: Kind
  id: string
  data: Data
  clock: Clock
  cursor: number
  /** list_pref, space_pref: whose it is. */
  owner?: number
  trashed_at?: number
}

interface Answer {
  status: number
  body?: unknown
  blob?: Blob
  headers?: Record<string, string>
}

interface Failure {
  /** `METHOD /path` (path without the query) or just `/path`. */
  match: string
  status: number
  code: string
  retryAfter?: number
  times: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE = '/api/app/1'

function error(status: number, code: string, extra: Record<string, unknown> = {}): Answer {
  return { status, body: { detail: { code, message: code.replace(/_/g, ' '), ...extra } } }
}

function hashOf(bytes: Uint8Array): string {
  // Not sha256: a fake only needs the same file to give the same answer.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4)
}

export class FakeServer {
  cursor = 0
  /** A `since` below this answers 410 (tombstones cleared). */
  oldest = 0
  /** The server's clock. */
  clock: () => number = () => Date.now()
  accounts = new Map<number, Account>()
  /** The account of the browser's session; null: signed out. */
  session: number | null = null
  rows = new Map<string, Row>()
  tombs = new Map<string, { kind: Kind; id: string; cursor: number; space_id: string | null }>()
  /** Entries `deleted: true` for one account (it left a space, or a record moved out of its sight). */
  hidden: { account: number; kind: Kind; id: string; cursor: number }[] = []
  results = new Map<string, Result>()
  invites = new Map<string, { id: string; space_id: string; expires_at: string; created_by: number; used: boolean }>()
  files = new Map<string, Blob>()
  devices: { id: string; account: number; name: string; created_at: string; last_seen: string | null }[] = []
  pairings = new Map<string, { id: string; account: number; code: string; state: 'waiting' | 'connected' | 'expired'; device: string | null; expires_at: string }>()
  webpush: { id: number; account: number; endpoint: string; agent: string; since: string }[] = []
  /** Notifications per account (`/api/notify`): the mail address and its confirmation, the choices, the times. */
  notify = new Map<number, { address: string; confirmed: boolean; pending: string; suggestion: string; routes: Record<string, string[]>; schedules: Record<string, { time: string; weekday: number }>; lastOk: string | null }>()
  /** Mails the fake server "sent": to, what. */
  mails: { to: string; kind: string; token?: string }[] = []
  settings: Record<string, unknown> = {
    app_enabled: true,
    app_pairing_allowed: true,
    invites_enabled: true,
    public_url: '',
    password_login: true,
    two_factor_required: false,
    backup_schedule: 'off',
    backup_keep: 7,
    smtp_host: '',
    smtp_port: 587,
    smtp_security: 'starttls',
    smtp_user: '',
    smtp_password_set: false,
    smtp_from: '',
    api_tokens_allowed: true,
    upload_max_mb: 50,
    upload_ceiling_mb: 50,
    strip_location: true,
    update_check: false,
  }
  features = ['changes', 'batch', 'files', 'wait', 'invites', 'webpush']
  limits = { attachment_bytes: 50 * 1024 * 1024 }
  failures: Failure[] = []
  requests: { method: string; path: string; body: unknown }[] = []
  /** How long `/wait` waits without news, ms. */
  waitMs = 25_000
  /** Answers on their way. */
  pending = 0
  private waiters = new Set<() => void>()
  private nextAccount = 1

  // ---- Building a world ---------------------------------------------------------------------------------------------

  iso(ms = this.clock()): string {
    return new Date(ms).toISOString()
  }

  private bump(): number {
    this.cursor += 1
    for (const wake of this.waiters) wake()
    return this.cursor
  }

  /** An account with its space "Privat" and the first list in it. */
  addAccount(name: string, options: Partial<Pick<Account, 'operator' | 'language' | 'timezone' | 'password' | 'username'>> & { privateId?: string; firstListId?: string } = {}): number {
    const id = this.nextAccount++
    const language = options.language ?? 'en'
    this.accounts.set(id, { id, name, username: options.username ?? name.toLowerCase(), operator: options.operator ?? id === 1, timezone: options.timezone ?? 'Europe/Berlin', language, avatar_hash: null, password: options.password ?? 'password-123' })
    const space = this.addSpace(language === 'de' ? 'Privat' : 'Private', id, { private: true, id: options.privateId })
    this.addList(space, language === 'de' ? 'Aufgaben' : 'Tasks', { id: options.firstListId })
    return id
  }

  private set(kind: Kind, id: string, data: Data, owner?: number): Row {
    const made = fresh(kind, id)
    const row: Row = { kind, id, data: { ...made.data, ...data, id }, clock: made.clock, cursor: this.bump(), owner }
    for (const key of Object.keys(row.clock)) row.clock[key] = 1
    this.rows.set(owner !== undefined ? `${kind}:${owner}:${id}` : `${kind}:${id}`, row)
    return row
  }

  /** A person's own setting (`list_pref`, `space_pref`) as if made on another device. */
  addPref(kind: 'list_pref' | 'space_pref', id: string, owner: number, data: Data): void {
    this.set(kind, id, data, owner)
  }

  addSpace(name: string, manager: number, options: { private?: boolean; color?: string; icon?: string; id?: string } = {}): string {
    const id = options.id ?? uuid4()
    this.set('space', id, { name, private: !!options.private, color: options.color ?? 'blue', icon: options.icon ?? 'list' })
    this.join(id, manager, 'manager')
    return id
  }

  join(spaceId: string, account: number, role: 'manager' | 'member' = 'member'): void {
    const id = `${spaceId}:${account}`
    const row = this.set('member', id, { space_id: spaceId, account_id: account, role, position: null, joined_at: this.iso(), granted_cursor: 0 })
    row.data.granted_cursor = row.cursor
  }

  addList(spaceId: string, name: string, options: { id?: string; color?: string; icon?: string; view?: 'list' | 'columns' } = {}): string {
    const id = options.id ?? uuid4()
    const siblings = [...this.rows.values()].filter((r) => r.kind === 'list' && r.data.space_id === spaceId).map((r) => ({ position: r.data.position as string }))
    this.set('list', id, { space_id: spaceId, name, color: options.color ?? 'blue', icon: options.icon ?? 'list', view: options.view ?? 'list', position: keyAtEnd(siblings) })
    return id
  }

  addSection(listId: string, name: string, position: string, id = uuid4()): string {
    this.set('section', id, { list_id: listId, name, position })
    return id
  }

  addReminder(listId: string, title: string, data: Data = {}, id = uuid4()): string {
    const siblings = [...this.rows.values()].filter((r) => r.kind === 'reminder' && r.data.list_id === listId).map((r) => ({ position: r.data.position as string }))
    this.set('reminder', id, { list_id: listId, title, position: keyAtEnd(siblings), created_at: this.iso(), created_by: 1, ...data })
    return id
  }

  row(kind: Kind, id: string): Row | undefined {
    return this.rows.get(`${kind}:${id}`)
  }

  data(kind: Kind, id: string): Data | undefined {
    return this.row(kind, id)?.data
  }

  /** Changes a record as the server itself would (a change by another device). */
  change(kind: Kind, id: string, fields: Data, clock?: number): void {
    const row = this.row(kind, id)!
    const time = clock ?? this.clock()
    Object.assign(row.data, fields)
    for (const field of Object.keys(fields)) {
      const key = kind === 'reminder' ? reminderKey(field) : field
      if (key) row.clock[key] = time
    }
    row.cursor = this.bump()
  }

  /** A record gone for good. */
  bury(kind: Kind, id: string): void {
    const row = this.row(kind, id)
    const space = row ? this.spaceOf(row) : null
    this.rows.delete(`${kind}:${id}`)
    this.tombs.set(`${kind}:${id}`, { kind, id, cursor: this.bump(), space_id: space })
  }

  fail(match: string, status: number, code: string, times = 1, retryAfter?: number): void {
    this.failures.push({ match, status, code, times, retryAfter })
  }

  // ---- Seeing ---------------------------------------------------------------------------------------------------------

  private spaceOf(row: Row): string | null {
    switch (row.kind) {
      case 'space':
        return row.id
      case 'member':
      case 'list':
        return row.data.space_id as string
      case 'section':
      case 'reminder': {
        const list = this.row('list', row.data.list_id as string)
        return list ? (list.data.space_id as string) : null
      }
      case 'attachment': {
        const reminder = this.row('reminder', row.data.reminder_id as string)
        return reminder ? this.spaceOf(reminder) : null
      }
      case 'list_pref': {
        const list = this.row('list', row.id)
        return list ? (list.data.space_id as string) : null
      }
      case 'space_pref':
        return row.id
    }
  }

  member(space: string | null, account: number): Row | undefined {
    return space ? this.row('member', `${space}:${account}`) : undefined
  }

  private sees(account: number, row: Row): boolean {
    if ((row.kind === 'list_pref' || row.kind === 'space_pref') && row.owner !== account) return false
    return !!this.member(this.spaceOf(row), account)
  }

  item(row: Row, account: number): Item {
    const data: Data = { ...row.data }
    if (row.kind === 'space') data.role = this.member(row.id, account)?.data.role ?? 'member'
    if (row.kind === 'member') {
      delete data.joined_at
      delete data.granted_cursor
      if (data.account_id !== account) data.position = null
    }
    const clock = row.kind === 'member' || row.kind === 'attachment' ? {} : { ...row.clock }
    return { kind: row.kind, id: row.id, cursor: row.cursor, deleted: false, data, clock }
  }

  private people(account: number): { id: number; name: string | null; avatar_hash: string | null }[] {
    const ids = new Set<number>([account])
    for (const row of this.rows.values()) {
      if (!this.sees(account, row)) continue
      if (row.kind === 'member') ids.add(row.data.account_id as number)
      if (row.kind === 'reminder') {
        for (const field of ['created_by', 'completed_by']) if (typeof row.data[field] === 'number') ids.add(row.data[field] as number)
        for (const id of (row.data.assignees as number[]) ?? []) ids.add(id)
      }
    }
    return [...ids].map((id) => {
      const a = this.accounts.get(id)
      return { id, name: a?.name ?? null, avatar_hash: a?.avatar_hash ?? null }
    })
  }

  changes(account: number, since: number, limit: number): Answer {
    if (since > this.cursor || (since !== 0 && since < this.oldest)) return error(410, 'cursor_expired')
    const best = new Map<string, { at: number; item: Item }>()
    const offer = (key: string, at: number, item: Item) => {
      const was = best.get(key)
      if (!was || was.at < at) best.set(key, { at, item })
    }
    for (const row of this.rows.values()) {
      if (!this.sees(account, row)) continue
      const granted = (this.member(this.spaceOf(row), account)?.data.granted_cursor as number) ?? 0
      const at = Math.max(row.cursor, granted)
      if (at > since) offer(`${row.kind}:${row.id}`, at, { ...this.item(row, account), cursor: at })
    }
    for (const tomb of this.tombs.values()) {
      if (tomb.cursor > since && (tomb.space_id === null || this.member(tomb.space_id, account)))
        offer(`${tomb.kind}:${tomb.id}`, tomb.cursor, { kind: tomb.kind, id: tomb.id, cursor: tomb.cursor, deleted: true, data: null, clock: null })
    }
    for (const gone of this.hidden) {
      if (gone.account === account && gone.cursor > since) offer(`${gone.kind}:${gone.id}`, gone.cursor, { kind: gone.kind, id: gone.id, cursor: gone.cursor, deleted: true, data: null, clock: null })
    }
    const all = [...best.values()].sort((a, b) => a.at - b.at || (a.item.kind + a.item.id < b.item.kind + b.item.id ? -1 : 1))
    const page = all.slice(0, limit)
    const more = all.length > limit
    const spaces = [...this.rows.values()].filter((r) => r.kind === 'space' && this.member(r.id, account)).map((r) => r.id)
    return {
      status: 200,
      body: { cursor: more ? page.at(-1)!.at : this.cursor, more, space_ids: spaces, people: this.people(account), items: page.map((p) => p.item) },
    }
  }

  // ---- Writing --------------------------------------------------------------------------------------------------------

  private result(op_id: string, ok: boolean, code: string | null, row: Row | undefined, account: number, extra: Partial<Result> = {}): Result {
    return { op_id, ok, ...(code ? { code } : {}), current: row && this.sees(account, row) ? this.item(row, account) : null, ...extra }
  }

  private ref(kind: Kind, id: unknown): 'missing' | 'gone' | Row {
    if (typeof id !== 'string') return 'missing'
    const row = this.row(kind, id)
    if (row) return row
    return this.tombs.has(`${kind}:${id}`) ? 'gone' : 'missing'
  }

  private invalidFields(kind: Kind, fields: Data): string[] {
    const bad: string[] = []
    const text = (name: string, min: number, max: number) => {
      if (!(name in fields)) return
      const value = fields[name]
      if (typeof value !== 'string' || textLength(value) < min || textLength(value) > max) bad.push(name)
    }
    const position = (name: string) => {
      if (name in fields && !isValidKey(fields[name])) bad.push(name)
    }
    if (kind === 'space' || kind === 'list' || kind === 'section') text('name', 1, 80)
    if (kind === 'list' || kind === 'section' || kind === 'reminder') position('position')
    if (kind === 'list' && 'view' in fields && !['list', 'columns'].includes(fields.view as string)) bad.push('view')
    if (kind === 'reminder') {
      text('title', 1, 500)
      text('notes', 0, 20_000)
      if ('url' in fields && fields.url !== null && !(typeof fields.url === 'string' && /^(https?:|mailto:)/i.test(fields.url) && textLength(fields.url) <= 2000)) bad.push('url')
      if ('priority' in fields && ![0, 1, 2, 3].includes(fields.priority as number)) bad.push('priority')
      if ('due_date' in fields && fields.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(fields.due_date))) bad.push('due_date')
      if ('due_time' in fields && fields.due_time !== null && !/^\d{2}:\d{2}$/.test(String(fields.due_time))) bad.push('due_time')
      if ('repeat' in fields && fields.repeat !== null && !parseRule(fields.repeat as string, (fields.repeat_from as 'due' | 'completion') ?? 'due')) bad.push('repeat')
      if ('tags' in fields && (!Array.isArray(fields.tags) || fields.tags.length > 20)) bad.push('tags')
      if ('assignees' in fields && (!Array.isArray(fields.assignees) || fields.assignees.length > 10)) bad.push('assignees')
    }
    return bad
  }

  private put(account: number, op: PutOp): Result {
    const fail = (code: string, row?: Row, extra: Partial<Result> = {}) => this.result(op.op_id, false, code, row, account, extra)
    if (!['space', 'list', 'section', 'reminder', 'list_pref', 'space_pref'].includes(op.kind) || !UUID.test(op.id)) return fail('invalid')
    if (this.tombs.has(`${op.kind}:${op.id}`)) return fail('gone')
    const own = op.kind === 'list_pref' || op.kind === 'space_pref'
    const key = own ? `${op.kind}:${account}:${op.id}` : `${op.kind}:${op.id}`
    const existing = this.rows.get(key)
    if (existing && !this.sees(account, existing)) return fail('not_found')
    const fields: Data = {}
    const ignored: string[] = []
    for (const [field, value] of Object.entries(op.fields)) {
      if (SERVER_ONLY.includes(field)) ignored.push(field)
      else fields[field] = typeof value === 'string' && ['title', 'name', 'notes'].includes(field) ? cleanText(value) : value
    }
    if ('tags' in fields && Array.isArray(fields.tags)) fields.tags = cleanTags(fields.tags as string[])
    const bad = this.invalidFields(op.kind, fields)
    if (bad.length) return fail('invalid', existing, { fields: bad } as Partial<Result>)
    const creating = !existing
    if (creating && (REQUIRED[op.kind] ?? []).some((f) => !(f in fields))) return fail('invalid', undefined, { fields: (REQUIRED[op.kind] ?? []).filter((f) => !(f in fields)) } as Partial<Result>)
    if (!creating && 'completed_at' in fields && fields.completed_at !== null) return fail('invalid', existing, { fields: ['completed_at'] } as Partial<Result>)

    // Where it goes: the space it ends up in.
    let space: string | null = existing ? this.spaceOf(existing) : null
    if (op.kind === 'space') {
      if (existing) {
        if (this.member(op.id, account)?.data.role !== 'manager') return fail('forbidden', existing)
        if (existing.data.private && 'deleted_at' in fields && fields.deleted_at) return fail('forbidden', existing)
      }
    }
    if (op.kind === 'list' && 'space_id' in fields) {
      const target = this.ref('space', fields.space_id)
      if (target === 'missing') return fail('parent_missing', existing)
      if (target === 'gone') return fail('gone', existing)
      if (!this.member(target.id, account) || (target.data.private && !this.member(target.id, account))) return fail('not_found', existing)
      space = target.id
    }
    if ((op.kind === 'section' || op.kind === 'reminder') && 'list_id' in fields) {
      const list = this.ref('list', fields.list_id)
      if (list === 'missing') return fail('parent_missing', existing)
      if (list === 'gone') return fail('gone', existing)
      if (!this.sees(account, list)) return fail('not_found', existing)
      space = list.data.space_id as string
    }
    if (op.kind === 'reminder' && typeof fields.parent_id === 'string') {
      const parent = this.ref('reminder', fields.parent_id)
      if (parent === 'missing') return fail('parent_missing', existing)
      if (parent === 'gone') return fail('gone', existing)
    }
    if (op.kind === 'list_pref') {
      const list = this.row('list', op.id)
      if (!list || !this.sees(account, list)) return fail('not_found')
    }
    if (op.kind === 'space_pref') {
      const target = this.ref('space', op.id)
      if (target === 'missing') return fail('parent_missing')
      if (target === 'gone') return fail('gone')
      if (!this.member(op.id, account)) return fail('not_found')
    }
    const before = existing ? this.spaceOf(existing) : null

    // Assignees: only members of the space; none in "Privat".
    let dropped: number[] = []
    if (op.kind === 'reminder' && Array.isArray(fields.assignees) && space) {
      const isPrivate = !!this.row('space', space)?.data.private
      const wanted = fields.assignees as number[]
      const kept = isPrivate ? [] : wanted.filter((id) => this.member(space, id))
      dropped = wanted.filter((id) => !kept.includes(id))
      fields.assignees = kept
    }

    const now = this.clock()
    const clock: Clock = {}
    for (const [k, time] of Object.entries(op.clock)) clock[k] = time > now + 2000 ? now : time
    let row = existing
    if (!row) {
      const made = fresh(op.kind, op.id)
      row = { kind: op.kind, id: op.id, data: made.data, clock: made.clock, cursor: 0, owner: own ? account : undefined }
      if (op.kind === 'reminder') {
        row.data.created_by = account
        const created = typeof op.fields.created_at === 'string' ? Date.parse(op.fields.created_at) : NaN
        row.data.created_at = Number.isFinite(created) && created <= now ? new Date(created).toISOString() : this.iso(now)
      }
      if (op.kind === 'reminder' && typeof fields.completed_at === 'string') row.data.completed_by = account
    }
    const applied = mergeInto(op.kind, row.data, row.clock, fields, clock)
    for (const k of Object.keys(clock)) if (!applied.includes(k)) ignored.push(k)
    if (op.kind === 'reminder' && applied.includes('completion') && row.data.completed_at === null) row.data.completed_by = null
    if (op.kind === 'reminder' && 'created_at' in fields) delete fields.created_at
    row.cursor = this.bump()
    this.rows.set(key, row)
    if (creating && op.kind === 'space') this.join(op.id, account, 'manager')
    if (op.kind === 'list' && before && space && before !== space) this.moved(op.id, before, space)
    return this.result(op.op_id, true, null, row, account, { applied, ignored, dropped_assignees: dropped })
  }

  /** A list changed its space: it and its children get new cursors; who no longer sees it gets `deleted`. */
  private moved(listId: string, from: string, to: string): void {
    const family = [...this.rows.values()].filter((r) => (r.kind === 'list' && r.id === listId) || ((r.kind === 'section' || r.kind === 'reminder') && r.data.list_id === listId) || (r.kind === 'list_pref' && r.id === listId))
    const reminders = new Set(family.filter((r) => r.kind === 'reminder').map((r) => r.id))
    for (const row of this.rows.values()) if (row.kind === 'attachment' && reminders.has(row.data.reminder_id as string)) family.push(row)
    const toMembers = new Set([...this.rows.values()].filter((r) => r.kind === 'member' && r.data.space_id === to).map((r) => r.data.account_id as number))
    const now = this.clock()
    for (const row of family) {
      row.cursor = this.bump()
      if (row.kind === 'reminder') {
        const kept = ((row.data.assignees as number[]) ?? []).filter((id) => toMembers.has(id) && !this.row('space', to)?.data.private)
        if (kept.length !== ((row.data.assignees as number[]) ?? []).length) {
          row.data.assignees = kept
          row.clock.assignees = now
        }
      }
    }
    for (const m of this.rows.values()) {
      if (m.kind !== 'member' || m.data.space_id !== from || toMembers.has(m.data.account_id as number)) continue
      for (const row of family) this.hidden.push({ account: m.data.account_id as number, kind: row.kind, id: row.id, cursor: this.bump() })
    }
  }

  private remove(account: number, op: DeleteOp): Result {
    if (!['section', 'attachment'].includes(op.kind)) return this.result(op.op_id, false, 'invalid', undefined, account)
    const row = this.row(op.kind, op.id)
    if (!row) return this.tombs.has(`${op.kind}:${op.id}`) ? this.result(op.op_id, true, null, undefined, account) : this.result(op.op_id, false, 'not_found', undefined, account)
    if (!this.sees(account, row)) return this.result(op.op_id, false, 'not_found', undefined, account)
    this.bury(op.kind, op.id)
    return this.result(op.op_id, true, null, undefined, account)
  }

  private complete(account: number, op: CompleteOp): Result {
    if (this.tombs.has(`reminder:${op.id}`)) return this.result(op.op_id, false, 'gone', undefined, account)
    const row = this.row('reminder', op.id)
    if (!row || !this.sees(account, row)) return this.result(op.op_id, false, 'not_found', undefined, account)
    const world: CompleteWorld = {
      reminder: (id) => this.row('reminder', id),
      children: (id) => [...this.rows.values()].filter((r) => r.kind === 'reminder' && r.data.parent_id === id),
      save: (id, record: Stored) => {
        const existing = this.row('reminder', id)
        if (existing) {
          existing.data = record.data
          existing.clock = record.clock
          existing.cursor = this.bump()
        } else this.rows.set(`reminder:${id}`, { kind: 'reminder', id, data: record.data, clock: record.clock, cursor: this.bump() })
      },
    }
    const outcome = applyComplete(world, op.id, op.occurrence, op.at, op.on, account)
    const copyRow = outcome.copy_id ? this.row('reminder', outcome.copy_id) : op.occurrence ? undefined : undefined
    const copy = copyRow ? this.item(copyRow, account) : null
    if (outcome.code !== 'ok') return this.result(op.op_id, false, outcome.code, row, account)
    return this.result(op.op_id, true, null, this.row('reminder', op.id), account, { copy_id: outcome.copy_id, next_due: outcome.next_due, copy })
  }

  private position(account: number, op: PositionOp): Result {
    const row = this.member(op.space_id, account)
    if (!row) return this.result(op.op_id, false, 'not_found', undefined, account)
    if (op.position !== null && !isValidKey(op.position)) return this.result(op.op_id, false, 'invalid', row, account)
    row.data.position = op.position
    row.cursor = this.bump()
    return this.result(op.op_id, true, null, row, account)
  }

  apply(account: number, op: Op): Result {
    const seen = this.results.get(`${account}:${op.op_id}`)
    if (seen) return seen
    let result: Result
    switch (op.type) {
      case 'put':
        result = this.put(account, op)
        break
      case 'delete':
        result = this.remove(account, op)
        break
      case 'complete':
        result = this.complete(account, op)
        break
      case 'position':
        result = this.position(account, op)
        break
      default:
        result = { op_id: (op as Op).op_id, ok: false, code: 'invalid', current: null }
    }
    this.results.set(`${account}:${op.op_id}`, result)
    return result
  }

  private async file(account: number, form: FormData): Promise<Answer> {
    const id = String(form.get('id') ?? '')
    const reminderId = String(form.get('reminder_id') ?? '')
    const opId = String(form.get('op_id') ?? '')
    const file = form.get('file')
    if (!(file instanceof Blob) || !UUID.test(id) || !opId) return error(422, 'invalid_input', { fields: ['file'] })
    const seen = this.results.get(`${account}:${opId}`)
    if (seen) return { status: 200, body: seen }
    if (file.size > this.limits.attachment_bytes) return error(413, 'too_large')
    const done = (result: Result) => {
      this.results.set(`${account}:${opId}`, result)
      return { status: 200, body: result }
    }
    if (this.tombs.has(`attachment:${id}`) || this.tombs.has(`reminder:${reminderId}`)) return done({ op_id: opId, ok: false, code: 'gone', current: null })
    const reminder = this.row('reminder', reminderId)
    if (!reminder || !this.sees(account, reminder)) return done({ op_id: opId, ok: false, code: 'not_found', current: null })
    if (file.size === 0) return done({ op_id: opId, ok: false, code: 'invalid', current: null })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const hash = hashOf(bytes)
    const existing = this.row('attachment', id)
    if (existing) return done(this.result(opId, existing.data.hash === hash, existing.data.hash === hash ? null : 'invalid', existing, account))
    this.files.set(hash, new Blob([bytes], { type: file.type }))
    const name = (file as File).name || 'file'
    const row: Row = { kind: 'attachment', id, data: { id, reminder_id: reminderId, name, mime: file.type || 'application/octet-stream', size: file.size, hash, created_by: account, created_at: this.iso() }, clock: {}, cursor: this.bump() }
    this.rows.set(`attachment:${id}`, row)
    return done(this.result(opId, true, null, row, account))
  }

  // ---- Members and invitations ------------------------------------------------------------------------------------------

  private managers(space: string): number[] {
    return [...this.rows.values()].filter((r) => r.kind === 'member' && r.data.space_id === space && r.data.role === 'manager').map((r) => r.data.account_id as number)
  }

  private membersOf(space: string): number[] {
    return [...this.rows.values()].filter((r) => r.kind === 'member' && r.data.space_id === space).map((r) => r.data.account_id as number)
  }

  /** Someone leaves a space: out of every `assignees` there, the space out of their sight. */
  leave(space: string, account: number): void {
    const now = this.clock()
    const spaceRows = [...this.rows.values()].filter((r) => this.spaceOf(r) === space)
    for (const row of spaceRows) {
      if (row.kind !== 'reminder') continue
      const list = (row.data.assignees as number[]) ?? []
      if (!list.includes(account)) continue
      row.data.assignees = list.filter((id) => id !== account)
      row.clock.assignees = now
      row.cursor = this.bump()
    }
    this.rows.delete(`member:${space}:${account}`)
    this.tombs.set(`member:${space}:${account}`, { kind: 'member', id: `${space}:${account}`, cursor: this.bump(), space_id: space })
    for (const row of spaceRows) {
      if ((row.kind === 'list_pref' || row.kind === 'space_pref') && row.owner !== account) continue
      this.hidden.push({ account, kind: row.kind, id: row.id, cursor: this.bump() })
    }
  }

  private spaceCall(account: number, method: string, parts: string[], body: Data): Answer {
    const [spaceId, what, sub] = parts
    const space = this.row('space', spaceId)
    const mine = this.member(spaceId, account)
    if (!space || !mine) return error(404, 'not_found')
    const manager = mine.data.role === 'manager'
    if (what === 'invites') {
      if (!manager) return error(403, 'forbidden')
      if (method === 'GET')
        return { status: 200, body: [...this.invites.values()].filter((i) => i.space_id === spaceId && !i.used).map((i) => ({ id: i.id, expires_at: i.expires_at, created_by: i.created_by })) }
      if (method === 'POST') {
        if (!this.settings.invites_enabled) return error(403, 'invites_disabled')
        if (space.data.private) return error(403, 'private_space')
        const secret = uuid4().replace(/-/g, '')
        const invite = { id: uuid4(), space_id: spaceId, expires_at: this.iso(this.clock() + 7 * 86_400_000), created_by: account, used: false }
        this.invites.set(secret, invite)
        const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
        return { status: 200, body: { id: invite.id, link: `${origin}/invite/${secret}`, expires_at: invite.expires_at } }
      }
      if (method === 'DELETE' && sub) {
        for (const [secret, invite] of this.invites) if (invite.id === sub && invite.space_id === spaceId) this.invites.delete(secret)
        return { status: 204 }
      }
    }
    if (what === 'members' && sub) {
      const target = Number(sub)
      const row = this.member(spaceId, target)
      if (!row) return error(404, 'not_found')
      const others = this.membersOf(spaceId).filter((id) => id !== target).length > 0
      const lastManager = row.data.role === 'manager' && this.managers(spaceId).length === 1 && others
      if (method === 'PUT') {
        if (!manager) return error(403, 'forbidden')
        if (body.role !== 'manager' && body.role !== 'member') return error(422, 'invalid_input', { fields: ['role'] })
        if (body.role === 'member' && lastManager) return error(409, 'last_manager')
        row.data.role = body.role
        row.cursor = this.bump()
        this.row('space', spaceId)!.cursor = this.bump()
        return { status: 200, body: this.item(row, account).data }
      }
      if (method === 'DELETE') {
        if (!manager && target !== account) return error(403, 'forbidden')
        if (space.data.private) return error(403, 'private_space')
        if (lastManager) return error(409, 'last_manager')
        this.leave(spaceId, target)
        return { status: 204 }
      }
    }
    return error(404, 'not_found')
  }

  private inviteCall(method: string, secret: string, action: string | undefined): Answer {
    const invite = this.invites.get(secret)
    if (!invite || invite.used || Date.parse(invite.expires_at) < this.clock()) return error(404, 'invite_unknown')
    const space = this.row('space', invite.space_id)
    if (!space) return error(404, 'invite_unknown')
    if (method === 'GET' && !action) {
      const by = this.accounts.get(invite.created_by)
      return {
        status: 200,
        body: { space_name: space.data.name, invited_by: by?.name ?? null, expires_at: invite.expires_at, already_member: this.session !== null && !!this.member(invite.space_id, this.session), signed_in: this.session !== null },
      }
    }
    if (method === 'POST' && action === 'accept') {
      if (this.session === null) return error(401, 'not_signed_in')
      if (!this.member(invite.space_id, this.session)) {
        this.join(invite.space_id, this.session, 'member')
        invite.used = true
      }
      return { status: 200, body: { space_id: invite.space_id } }
    }
    return error(404, 'not_found')
  }

  /** A new account through a space invitation (`POST /api/invite/{secret}` {name, password}): signed in and member. */
  private joinWithAccount(secret: string, body: Data): Answer {
    const invite = this.invites.get(secret)
    if (!invite || invite.used || Date.parse(invite.expires_at) < this.clock()) return error(404, 'invite_unknown')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!name) return error(422, 'invalid_input', { fields: ['name'] })
    if (password.length < 10) return error(422, 'password_too_short', { min: 10 })
    if ([...this.accounts.values()].some((a) => a.username === name.toLowerCase())) return error(409, 'name_taken')
    this.session = this.addAccount(name, { password, operator: false })
    this.join(invite.space_id, this.session, 'member')
    invite.used = true
    return { status: 200, body: { space_id: invite.space_id } }
  }

  // ---- The old paths the frame needs ------------------------------------------------------------------------------------

  oldMe(account: Account): Record<string, unknown> {
    return {
      id: account.id,
      name: account.username,
      display_name: account.name,
      role: account.operator ? 'operator' : 'member',
      sign_in: 'password',
      email: '',
      language: account.language,
      two_factor: false,
      two_factor_recovery_left: 0,
      avatar: null,
      version: 'dev',
      whats_new_seen: 'dev',
      mail: !!this.settings.smtp_host,
    }
  }

  /** The notifications of one account, made on first use: mail off, the browsers and the app on for what they
   * carried before there were choices (due, assigned, changed), as the real server. */
  notifyOf(account: number) {
    let found = this.notify.get(account)
    if (!found) {
      const pushed = ['webpush', 'app']
      found = { address: '', confirmed: false, pending: '', suggestion: '', routes: { assigned: [...pushed], due: [...pushed], changed: [...pushed] }, schedules: { daily: { time: '07:00', weekday: 6 }, weekly: { time: '18:00', weekday: 6 } }, lastOk: null }
      this.notify.set(account, found)
    }
    return found
  }

  /** Whether a channel can take something for the account now (mail: a mail server and a confirmed address). */
  channelReady(account: number, kind: string): boolean {
    if (kind === 'mail') return !!this.settings.smtp_host && this.notifyOf(account).confirmed
    if (kind === 'webpush') return this.webpush.some((w) => w.account === account)
    if (kind === 'app') return this.devices.some((d) => d.account === account)
    return false
  }

  /** What `GET /api/notify` answers: every channel with its name, symbol and state, as the real one. */
  notifyState(account: Account): Record<string, unknown> {
    const own = this.notifyOf(account.id)
    const mail = !!this.settings.smtp_host
    const browsers = this.webpush.filter((w) => w.account === account.id)
    const paired = this.devices.filter((d) => d.account === account.id).length
    const stamp = { last_ok_at: null, last_error: '', last_error_at: null }
    const channels = [
      {
        kind: 'mail', name: 'Mail', icon: 'mail', available: mail, ready: this.channelReady(account.id, 'mail'), defaults: [],
        state: !mail ? 'unavailable' : own.confirmed ? 'ready' : 'setup',
        summary: !mail ? 'No mail server' : own.confirmed ? own.address : 'Confirm an address first',
        hint: !mail ? 'Mail comes once the operator sets up a mail server.' : own.confirmed ? 'confirmed' : 'Enter your mail address below and open the link.',
        link: '', link_label: '', ...stamp, last_ok_at: own.lastOk,
        address: own.confirmed ? own.address : '', confirmed: own.confirmed, pending: own.pending, pending_until: own.pending ? this.iso(this.clock() + 86_400_000) : null, suggestion: own.confirmed ? '' : own.suggestion, can_send: !!this.settings.public_url,
      },
      {
        kind: 'webpush', name: 'Browser', icon: 'globe', available: true, ready: browsers.length > 0, defaults: ['assigned', 'changed', 'due'],
        state: browsers.length ? 'ready' : 'setup', summary: browsers.length === 1 ? '1 browser' : browsers.length ? `${browsers.length} browsers` : 'No browser',
        hint: browsers.length ? '' : 'Turn notifications on in a browser.', link: '', link_label: '', ...stamp,
        browsers: browsers.map((w) => ({ id: w.id, browser: /Firefox/.test(w.agent) ? 'Firefox' : /Chrome/.test(w.agent) ? 'Chrome' : '', system: /Windows/.test(w.agent) ? 'Windows' : /Android/.test(w.agent) ? 'Android' : '', since: w.since, last_ok_at: null, mark: `mark-${w.endpoint}` })),
      },
      {
        kind: 'app', name: 'iPhone/iPad', icon: 'smartphone', available: true, ready: paired > 0, defaults: ['assigned', 'changed', 'due'],
        state: paired ? 'ready' : 'setup', summary: paired === 1 ? '1 device paired' : paired ? `${paired} devices paired` : 'No device',
        hint: paired ? '' : 'Pair the app under Connections.', link: paired ? '' : '/account?tab=connections', link_label: paired ? '' : 'Pair the app', ...stamp,
      },
    ]
    const routes: Record<string, string[]> = {}
    for (const event of ['daily', 'weekly', 'assigned', 'due', 'changed', 'joined']) routes[event] = ['mail', 'webpush', 'app'].filter((kind) => (own.routes[event] ?? []).includes(kind))
    return { channels, reports: ['daily', 'weekly'], events: ['assigned', 'due', 'changed', 'joined'], routes, schedules: own.schedules, timezone: account.timezone }
  }

  /** Opens the confirmation link of the last mail to `address` (as its owner would). */
  confirmMail(token: string): boolean {
    for (const [, own] of this.notify) {
      if (own.pending && this.mails.some((m) => m.token === token && m.to === own.pending)) {
        own.address = own.pending
        own.pending = ''
        own.confirmed = true
        return true
      }
    }
    return false
  }

  private old(method: string, path: string, body: Data): Answer | null {
    const me = this.session !== null ? this.accounts.get(this.session) : undefined
    if (path === '/api/setup' && method === 'GET') return { status: 200, body: { needs_setup: false, code_required: false, signed_in: !!me, version: 'dev', min_password: 10 } }
    if (path === '/api/auth/methods') return { status: 200, body: { password: true, providers: [] } }
    if (path === '/api/auth/login' && method === 'POST') {
      const found = [...this.accounts.values()].find((a) => a.username === String(body.name ?? '').toLowerCase() && a.password === body.password)
      if (!found) return error(401, 'wrong_password')
      this.session = found.id
      return { status: 200, body: this.oldMe(found) }
    }
    if (path === '/api/locales') return { status: 200, body: [] }
    if (path === '/api/email/confirm' && method === 'POST') {
      const token = String(body.token ?? '')
      if (!this.confirmMail(token)) return error(404, 'email_link_invalid')
      return { status: 200, body: { email: this.mails.find((m) => m.token === token)?.to ?? '' } }
    }
    const unsubscribe = path.match(/^\/api\/notify\/unsubscribe\/([A-Za-z0-9_-]+)$/)
    if (unsubscribe) {
      const [account, event, channel] = unsubscribe[1].split('-')
      const own = this.notify.get(Number(account))
      if (!own || !event || !channel) return error(404, 'unsubscribe_invalid')
      if (method === 'POST') own.routes[event] = (own.routes[event] ?? []).filter((c) => c !== channel)
      return { status: 200, body: { event, channel, on: (own.routes[event] ?? []).includes(channel) } }
    }
    if (!me) return path.startsWith('/api/') ? error(401, 'sign_in_required') : null
    if (path === '/api/notify' && method === 'GET') return { status: 200, body: this.notifyState(me) }
    if (path === '/api/notify/routes' && method === 'PUT') {
      const own = this.notifyOf(me.id)
      const event = String(body.event)
      const channel = String(body.channel)
      if (body.on && channel === 'mail' && !this.settings.smtp_host) return error(409, 'channel_unavailable')
      if (body.on && !this.channelReady(me.id, channel)) return error(409, 'channel_not_confirmed')
      const now = (own.routes[event] ?? []).filter((c) => c !== channel)
      own.routes[event] = body.on ? [...now, channel] : now
      return { status: 200, body: this.notifyState(me) }
    }
    const report = path.match(/^\/api\/notify\/schedules\/(daily|weekly)$/)
    if (report && method === 'PUT') {
      const own = this.notifyOf(me.id)
      own.schedules[report[1]] = { time: String(body.time), weekday: typeof body.weekday === 'number' ? body.weekday : own.schedules[report[1]].weekday }
      return { status: 200, body: this.notifyState(me) }
    }
    const browser = path.match(/^\/api\/notify\/browsers\/(\d+)$/)
    if (browser && method === 'DELETE') {
      const before = this.webpush.length
      this.webpush = this.webpush.filter((w) => !(w.id === Number(browser[1]) && w.account === me.id))
      if (this.webpush.length === before) return error(404, 'not_found')
      return { status: 200, body: this.notifyState(me) }
    }
    if (path === '/api/me/email' && method === 'PUT') {
      if (!this.settings.smtp_host) return error(409, 'mail_off')
      if (!this.settings.public_url) return error(409, 'public_url_missing')
      const own = this.notifyOf(me.id)
      const address = String(body.address ?? '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return error(422, 'invalid_email')
      own.pending = address
      this.mails.push({ to: address, kind: 'confirm', token: `nxm_${this.mails.length + 1}fake` })
      return { status: 200, body: { ...this.notifyState(me), sent: true } }
    }
    if (path === '/api/me/email' && method === 'DELETE') {
      const own = this.notifyOf(me.id)
      Object.assign(own, { address: '', confirmed: false, pending: '' })
      return { status: 200, body: this.notifyState(me) }
    }
    if (path === '/api/me/email/pending' && method === 'DELETE') {
      this.notifyOf(me.id).pending = ''
      return { status: 200, body: this.notifyState(me) }
    }
    if (path === '/api/me/email/resend' && method === 'POST') {
      const own = this.notifyOf(me.id)
      if (!own.pending) return error(404, 'email_nothing_waits')
      this.mails.push({ to: own.pending, kind: 'confirm', token: `nxm_${this.mails.length + 1}fake` })
      return { status: 200, body: this.notifyState(me) }
    }
    const spaceInvite = path.match(/^\/api\/spaces\/([^/]+)\/invites$/)
    if (spaceInvite && method === 'POST') {
      if (!this.settings.smtp_host) return error(409, 'mail_off')
      const id = uuid4()
      const invite = { id, space_id: spaceInvite[1], expires_at: this.iso(this.clock() + 7 * 86_400_000), created_by: me.id, used: false }
      this.invites.set(id, invite)
      this.mails.push({ to: String(body.email), kind: 'invite' })
      return { status: 201, body: { id, link: `${String(this.settings.public_url || 'http://localhost')}/invite/${id}`, expires_at: invite.expires_at, email: body.email, sent: true } }
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      this.session = null
      return { status: 204 }
    }
    if (path === '/api/auth/me') return { status: 200, body: this.oldMe(me) }
    if (path === '/api/me/language' && method === 'PUT') {
      me.language = String(body.language ?? me.language)
      return { status: 200, body: this.oldMe(me) }
    }
    if (path === '/api/me/profile' && method === 'PUT') {
      me.name = String(body.display_name ?? me.name)
      return { status: 200, body: this.oldMe(me) }
    }
    if (path === '/api/settings') {
      if (!me.operator) return error(403, 'forbidden')
      if (method === 'PUT') Object.assign(this.settings, body)
      return { status: 200, body: this.settings }
    }
    if (path === '/api/oidc/me') return { status: 200, body: [] }
    if (path === '/api/oidc/admin/providers') return { status: 200, body: [] }
    if (path === '/api/api-tokens') return { status: 200, body: { allowed: true, tokens: [], choices: [] } }
    if (path === '/api/admin/api-tokens') return { status: 200, body: [] }
    if (path === '/api/accounts') return { status: 200, body: [...this.accounts.values()].map((a) => ({ ...this.oldMe(a), locked: false, created_at: this.iso(), last_seen_at: null })) }
    if (path === '/api/invites' || path === '/api/backups') return { status: 200, body: [] }
    if (path === '/api/logs') return { status: 200, body: { entries: [], level: 'info' } }
    if (path === '/api/about') return { status: 200, body: { version: 'dev' } }
    if (path === '/api/me/whats-new/seen') return { status: 200, body: this.oldMe(me) }
    if (path === '/api/app-devices' && method === 'GET') return { status: 200, body: this.devices.filter((d) => d.account === me.id).map(({ account: _a, ...d }) => d) }
    const device = path.match(/^\/api\/app-devices\/([^/]+)$/)
    if (device && method === 'DELETE') {
      this.devices = this.devices.filter((d) => !(d.id === device[1] && d.account === me.id))
      return { status: 204 }
    }
    if (path === '/api/app-pairing' && method === 'POST') {
      if (!this.settings.app_pairing_allowed) return error(403, 'app_pairing_disabled')
      const address = String(this.settings.public_url || body.address || '')
      if (!address) return error(422, 'app_address_missing')
      if ([...this.pairings.values()].filter((p) => p.account === me.id && p.state === 'waiting').length >= 5) return error(409, 'app_too_many_pairings')
      const id = uuid4()
      const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      const code = Array.from({ length: 8 }, (_, i) => letters[(i * 7 + this.pairings.size * 3) % letters.length]).join('')
      const pairing = { id, account: me.id, code: `${code.slice(0, 4)}-${code.slice(4)}`, state: 'waiting' as const, device: null, expires_at: this.iso(this.clock() + 600_000) }
      this.pairings.set(id, pairing)
      const link = `nextasks://connect?address=${encodeURIComponent(address)}&pairing=${id}&secret=fake`
      const qr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1zM10 10h2v2h-2zM14 14h3v3h-3z" fill="#000"/></svg>`
      return { status: 200, body: { id, code: pairing.code, expires_at: pairing.expires_at, address, link, qr_svg: qr } }
    }
    const pairing = path.match(/^\/api\/app-pairing\/([^/]+)$/)
    if (pairing) {
      const found = this.pairings.get(pairing[1])
      if (!found || found.account !== me.id) return error(404, 'not_found')
      if (method === 'DELETE') {
        this.pairings.delete(found.id)
        return { status: 204 }
      }
      return { status: 200, body: { state: found.state, device: found.device } }
    }
    if (path === '/api/app-connect' && method === 'POST') return { status: 200, body: { link: `nextasks://connect?address=${encodeURIComponent(String(this.settings.public_url || 'http://localhost'))}&pairing=fake&secret=fake&device=${encodeURIComponent(String(body.device ?? ''))}` } }
    return null
  }

  /** Lets a pairing count as done (an iPhone took it). */
  connectPairing(id: string, device: string): void {
    const found = this.pairings.get(id)
    if (!found) return
    found.state = 'connected'
    found.device = device
    this.devices.push({ id: uuid4(), account: found.account, name: device, created_at: this.iso(), last_seen: this.iso() })
  }

  // ---- The door ---------------------------------------------------------------------------------------------------------

  /** One request, as `account` (the session's when not given). */
  async handle(method: string, url: string, body: unknown, account: number | null = this.session, headers: Record<string, string> = {}): Promise<Answer> {
    const parsed = new URL(url, 'http://fake')
    const path = parsed.pathname
    this.requests.push({ method, path: path + parsed.search, body: body instanceof FormData ? '[form]' : body })
    const failure = this.failures.find((f) => f.match === `${method} ${path}` || f.match === path)
    if (failure) {
      failure.times -= 1
      if (failure.times <= 0) this.failures = this.failures.filter((f) => f !== failure)
      const answer = error(failure.status, failure.code)
      if (failure.retryAfter) answer.headers = { 'Retry-After': String(failure.retryAfter) }
      return answer
    }
    const json = (body && !(body instanceof FormData) ? body : {}) as Data
    const invite = path.match(/^\/api\/invites\/([^/]+)(?:\/(accept))?$/)
    if (invite) return this.inviteCall(method, invite[1], invite[2])
    const join = path.match(/^\/api\/invite\/([^/]+)$/)
    if (join && method === 'POST') return this.joinWithAccount(join[1], json)
    if (!path.startsWith(BASE)) return this.old(method, path, json) ?? error(404, 'not_found')
    if (account === null) return error(401, 'not_signed_in')
    if (headers['x-nextasks-client'] !== undefined && headers['x-nextasks-client'] !== 'web') return error(403, 'bad_client')
    const me = this.accounts.get(account)!
    const rest = path.slice(BASE.length)
    const query = parsed.searchParams
    if (rest === '/me' && method === 'GET') return { status: 200, body: this.meBody(me) }
    if (rest === '/me' && method === 'PUT') {
      if (typeof json.timezone === 'string') me.timezone = json.timezone
      if (json.language === 'de' || json.language === 'en') me.language = json.language
      return { status: 200, body: this.meBody(me) }
    }
    if (rest === '/changes' && method === 'GET') {
      const since = Number(query.get('since') ?? 0)
      const limit = Math.min(1000, Number(query.get('limit') ?? 500))
      if (!Number.isInteger(since) || since < 0 || !(limit > 0)) return error(422, 'invalid_input', { fields: ['since'] })
      return this.changes(account, since, limit)
    }
    if (rest === '/wait' && method === 'GET') {
      const cursor = Number(query.get('cursor') ?? 0)
      if (cursor !== this.cursor) return { status: 200, body: { cursor: this.cursor } }
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(wake, this.waitMs)
        this.waiters.add(wake)
      })
      return { status: 200, body: { cursor: this.cursor } }
    }
    if (rest === '/batch' && method === 'POST') {
      const ops = (json.ops ?? null) as Op[] | null
      if (!Array.isArray(ops) || ops.length > 200) return error(422, 'invalid_input', { fields: ['ops'] })
      if (JSON.stringify(json).length > 2 * 1024 * 1024) return error(413, 'too_large')
      return { status: 200, body: { results: ops.map((op) => this.apply(account, op)), cursor: this.cursor } }
    }
    if (rest === '/files' && method === 'POST' && body instanceof FormData) return this.file(account, body)
    const file = rest.match(/^\/files\/([^/]+)$/)
    if (file && method === 'GET') {
      const row = this.row('attachment', file[1])
      if (!row || !this.sees(account, row)) return error(404, 'not_found')
      return { status: 200, blob: this.files.get(row.data.hash as string), headers: { ETag: String(row.data.hash) } }
    }
    const avatar = rest.match(/^\/people\/(\d+)\/avatar$/)
    if (avatar) return error(404, 'not_found')
    const spaceCall = rest.match(/^\/spaces\/([^/]+)\/(invites|members)(?:\/([^/]+))?$/)
    if (spaceCall) return this.spaceCall(account, method, [spaceCall[1], spaceCall[2], spaceCall[3]], json)
    if (rest === '/webpush/key' && method === 'GET') return { status: 200, body: { public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } }
    if (rest === '/webpush' && method === 'PUT') {
      this.webpush = this.webpush.filter((w) => w.endpoint !== json.endpoint)
      this.webpush.push({ id: this.webpush.reduce((top, w) => Math.max(top, w.id), 0) + 1, account, endpoint: String(json.endpoint), agent: typeof navigator === 'undefined' ? '' : navigator.userAgent, since: this.iso() })
      return { status: 204 }
    }
    if (rest === '/webpush' && method === 'DELETE') {
      this.webpush = this.webpush.filter((w) => w.endpoint !== json.endpoint)
      return { status: 204 }
    }
    return error(404, 'not_found')
  }

  private meBody(me: Account) {
    return {
      version: 'dev',
      now: this.clock(),
      account: { id: me.id, name: me.name, username: me.username, operator: me.operator, timezone: me.timezone, language: me.language, avatar_hash: me.avatar_hash },
      device: null,
      features: this.features,
      limits: this.limits,
    }
  }

  /** A `fetch` that talks to this server as `account` (the session's when not given). */
  fetcher(account?: number): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init.method ?? 'GET').toUpperCase()
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      let body: unknown = undefined
      if (init.body instanceof FormData) body = init.body
      else if (typeof init.body === 'string' && init.body) body = JSON.parse(init.body)
      else if (init.body instanceof Blob) body = init.body
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, key) => (headers[key.toLowerCase()] = value))
      this.pending += 1
      try {
        const answer = await new Promise<Answer>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          void this.handle(method, url, body, account ?? this.session, headers).then(resolve, reject)
        })
        const responseHeaders = new Headers(answer.headers)
        if (answer.blob) return new Response(answer.blob, { status: answer.status, headers: responseHeaders })
        if (answer.status === 204 || answer.body === undefined) return new Response(null, { status: answer.status === 200 ? 204 : answer.status, headers: responseHeaders })
        responseHeaders.set('Content-Type', 'application/json')
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: responseHeaders })
      } finally {
        this.pending -= 1
      }
    }
  }
}

function reminderKey(field: string): string | null {
  if (['list_id', 'section_id', 'parent_id', 'position'].includes(field)) return 'place'
  if (['due_date', 'due_time', 'repeat', 'repeat_from'].includes(field)) return 'due'
  if (['completed_at', 'completed_by'].includes(field)) return 'completion'
  if (['id', 'created_by', 'created_at'].includes(field)) return null
  return field
}

/** A small world: Robin (operator) and Alex, Robin's "Private" and a shared space "Family" with a list. */
export function smallWorld(server = new FakeServer()): { server: FakeServer; robin: number; alex: number; family: string; home: string; privateList: string } {
  const robin = server.addAccount('Robin', { operator: true })
  const alex = server.addAccount('Alex')
  const family = server.addSpace('Family', robin, { color: 'green', icon: 'house' })
  server.join(family, alex, 'member')
  const home = server.addList(family, 'Home', { color: 'orange', icon: 'house' })
  const privateList = [...server.rows.values()].find((r) => r.kind === 'list' && server.data('space', r.data.space_id as string)?.private && server.member(r.data.space_id as string, robin))!.id
  server.session = robin
  return { server, robin, alex, family, home, privateList }
}
