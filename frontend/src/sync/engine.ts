/**
 * The web's copy of everything the account sees, kept in step with the server over `/api/app/1` like the app does:
 * `/changes` page by page (from 0 on every start, as the web keeps nothing but the queue), `/wait` for news, own
 * changes into the queue and out through `/batch` and `/files`, each `Result` handled as the contract's table says.
 *
 * Clocks: server time = local time + the distance learnt from `now` in `/me` (renewed at least every 10 minutes).
 * Receiving: an entry from the server replaces data and clocks; only for keys with an own change still waiting, the
 * rule per field decides between entry and change (data model, "Empfangen").
 */
import { applyComplete, copyId, type CompleteWorld, type Stored } from './complete'
import { cleanTags, cleanText, fieldsOf, fresh, keyOf, REQUIRED } from './fields'
import { mergeInto } from './merge'
import { keyAtEnd } from './position'
import { browserBlobs, browserStorage, entryId, Queue, type BlobStore, type Entry, type KeyValue, type OpEntry, type UploadEntry } from './queue'
import { AppError, type Transport } from './transport'
import type { ChangesAnswer, CompleteOp, Data, Item, Kind, Me, Op, Person, PutOp, Reminder, Result } from './types'
import { uuid4 } from './uuid'
import { buildView, type Rec, type View } from './view'

export interface EngineOptions {
  transport: Transport
  storage?: KeyValue
  blobs?: BlobStore
  /** Keep asking `/wait` for news (off in most tests). */
  wait?: boolean
  /** The local clock in ms (tests set their own). */
  clock?: () => number
  /** Today in the browser's time zone, `YYYY-MM-DD`. */
  today?: () => string
  /** The session is gone (401): the page goes back to the sign-in; the queue stays. */
  onSignedOut?: () => void
  /** How many ops go in one `/batch` (at most 200). */
  batchSize?: number
  /** How many entries one page of `/changes` asks for (at most 1000). */
  pageSize?: number
}

export type SyncStatus = 'loading' | 'ready' | 'offline' | 'signedOut' | 'failed'

export interface Notice {
  id: number
  code: string
  values?: Record<string, unknown>
}

/** Codes after which the op leaves the queue and `current` is taken over (contract, "Was die App bzw. das Web …"). */
const FINAL = new Set(['forbidden', 'not_found', 'invalid', 'gone', 'already_done', 'due_changed'])
const MAX_BACKOFF = 5 * 60_000
const ME_EVERY = 10 * 60_000
const PAGE = 500

function localDay(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const keyFor = (kind: Kind, id: string) => `${kind}:${id}`

export class SyncEngine {
  records = new Map<string, Rec>()
  people = new Map<number, Person>()
  spaceIds: string[] = []
  cursor = 0
  me: Me | null = null
  /** Server time minus local time, ms. */
  offset = 0
  status: SyncStatus = 'loading'
  notices: Notice[] = []
  queue: Queue
  version = 0

  private readonly transport: Transport
  private readonly storage: KeyValue
  private readonly blobs: BlobStore
  private readonly localClock: () => number
  private readonly localToday: () => string
  private readonly batchSize: number
  private readonly listeners = new Set<() => void>()
  private cachedView: { version: number; view: View } | null = null
  private sending: Promise<void> | null = null
  private pulling: Promise<void> | null = null
  private inFlight = new Set<string>()
  private haltedUntil = 0
  private backoff = 0
  private solo = false
  private stopped = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private waitAbort: AbortController | null = null
  private noticeId = 0
  private lastMe = 0

  constructor(private readonly options: EngineOptions) {
    this.transport = options.transport
    this.storage = options.storage ?? browserStorage
    this.blobs = options.blobs ?? browserBlobs()
    this.localClock = options.clock ?? (() => Date.now())
    this.localToday = options.today ?? localDay
    this.batchSize = Math.min(200, options.batchSize ?? 200)
    this.queue = new Queue(this.storage, 'nextasks.queue.pending')
  }

  // ---- Life ---------------------------------------------------------------------------------------------------------

  /** Who one is, everything from the start, then the own waiting changes on top and out. */
  async start(): Promise<void> {
    try {
      await this.refreshMe()
      this.queue = new Queue(this.storage, `nextasks.queue.${this.me!.account.id}`)
      await this.pull(true)
      this.replay()
      this.status = 'ready'
    } catch (error) {
      if (error instanceof AppError && error.status === 401) this.signedOut()
      else this.status = error instanceof AppError && error.passing ? 'offline' : 'failed'
      this.bump()
      throw error
    }
    this.bump()
    void this.flush()
    if (this.options.wait) void this.waitLoop()
  }

  stop(): void {
    this.stopped = true
    this.waitAbort?.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private bump(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  view(): View {
    if (this.cachedView?.version !== this.version) this.cachedView = { version: this.version, view: buildView(this.records.values(), this.people, this.me?.account.id ?? 0) }
    return this.cachedView.view
  }

  /** The server's time as this browser reckons it, ms UTC. */
  now(): number {
    return Math.round(this.localClock() + this.offset)
  }

  nowIso(): string {
    return new Date(this.now()).toISOString()
  }

  today(): string {
    return this.localToday()
  }

  private later(ms: number, work: () => void): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer)
      work()
    }, ms)
    this.timers.push(timer)
  }

  private notice(code: string, values?: Record<string, unknown>): void {
    this.notices = [...this.notices, { id: ++this.noticeId, code, values }]
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id)
    this.bump()
  }

  private signedOut(): void {
    this.status = 'signedOut'
    this.options.onSignedOut?.()
  }

  // ---- Who am I -----------------------------------------------------------------------------------------------------

  async refreshMe(): Promise<Me> {
    const sent = this.localClock()
    const me = await this.transport.json<Me>('GET', '/me')
    const back = this.localClock()
    const serverNow = typeof me.now === 'number' ? me.now : Date.parse(me.now)
    this.offset = serverNow - back + (back - sent) / 2
    this.me = me
    this.lastMe = back
    this.bump()
    return me
  }

  private async keepClock(): Promise<void> {
    if (this.localClock() - this.lastMe < ME_EVERY) return
    try {
      await this.refreshMe()
    } catch {
      // The next round tries again.
    }
  }

  async setMe(change: { timezone?: string; language?: string }): Promise<void> {
    this.me = await this.transport.json<Me>('PUT', '/me', change)
    this.bump()
  }

  // ---- Fetching -----------------------------------------------------------------------------------------------------

  /** Everything new since the cursor, page by page; `full` starts from 0 and drops what did not come. */
  pull(full = false): Promise<void> {
    if (this.pulling) return this.pulling.then(() => (full ? this.pull(true) : undefined))
    this.pulling = (async () => {
      await null
      try {
        if (full) await this.fullLoad()
        else {
          try {
            await this.pages(this.cursor, null)
          } catch (error) {
            if (!(error instanceof AppError && error.status === 410)) throw error
            await this.fullLoad()
          }
        }
        if (this.status === 'offline') this.status = 'ready'
      } finally {
        this.pulling = null
        this.bump()
      }
    })()
    return this.pulling
  }

  /** `since=0`; afterwards every local record that did not come and has no own change waiting goes (410). */
  private async fullLoad(): Promise<void> {
    const delivered = new Set<string>()
    await this.pages(0, delivered)
    const waiting = this.pendingKeys()
    for (const key of [...this.records.keys()]) if (!delivered.has(key) && !waiting.has(key)) this.records.delete(key)
  }

  private async pages(since: number, delivered: Set<string> | null): Promise<void> {
    let cursor = since
    const removals: string[] = []
    for (;;) {
      const answer = await this.transport.json<ChangesAnswer>('GET', `/changes?since=${cursor}&limit=${Math.min(1000, this.options.pageSize ?? PAGE)}`)
      for (const person of answer.people) this.people.set(person.id, person)
      for (const item of answer.items) {
        // Removals wait for the end: a space that went needs its lists to know what was in it.
        if (item.deleted) removals.push(keyFor(item.kind, item.id))
        else {
          this.receive(item)
          delivered?.add(keyFor(item.kind, item.id))
        }
      }
      cursor = answer.cursor
      if (!answer.more) {
        this.cursor = answer.cursor
        this.spacesLeft(answer.space_ids)
        const waiting = this.pendingKeys()
        for (const key of removals) if (!waiting.has(key)) this.records.delete(key)
        return
      }
    }
  }

  private async waitLoop(): Promise<void> {
    let pause = 1000
    while (!this.stopped) {
      try {
        this.waitAbort = new AbortController()
        const answer = await this.transport.json<{ cursor: number }>('GET', `/wait?cursor=${this.cursor}`, undefined, this.waitAbort.signal)
        await this.keepClock()
        if (answer.cursor !== this.cursor) await this.pull()
        pause = 1000
        if (this.queue.length && !this.sending) void this.flush()
      } catch (error) {
        if (this.stopped) return
        if (error instanceof AppError && error.status === 401) return this.signedOut()
        if (error instanceof AppError && error.passing) {
          this.status = 'offline'
          this.bump()
        }
        await new Promise((resolve) => this.later(pause, () => resolve(null)))
        pause = Math.min(pause * 2, MAX_BACKOFF)
      }
    }
  }

  // ---- Receiving ----------------------------------------------------------------------------------------------------

  /** An entry from the server replaces the local record; own waiting changes go on top by the rule per field. */
  receive(item: Item): void {
    const key = keyFor(item.kind, item.id)
    if (item.deleted || !item.data) {
      // With an own change waiting, the record stays until that change has its result (or its space is cleared).
      if (!this.pendingKeys().has(key)) this.records.delete(key)
      return
    }
    const rec: Rec = { kind: item.kind, id: item.id, data: structuredClone(item.data), clock: structuredClone(item.clock ?? {}) }
    this.records.set(key, rec)
    this.overlay(rec)
  }

  /** The own waiting changes of one record, in their order. */
  private overlay(rec: Rec): void {
    const key = keyFor(rec.kind, rec.id)
    for (const entry of this.queue.entries) {
      if (entry.type !== 'op') continue
      const op = entry.op
      if (op.type === 'put' && op.kind === rec.kind && op.id === rec.id) mergeInto(rec.kind, rec.data, rec.clock, op.fields, op.clock)
      else if (op.type === 'delete' && op.kind === rec.kind && op.id === rec.id) this.records.delete(key)
      else if (op.type === 'complete' && rec.kind === 'reminder' && op.id === rec.id) this.completeLocally(op)
    }
  }

  /** After a reload: the waiting changes laid over what came, records made here only included. */
  private replay(): void {
    for (const entry of this.queue.entries) {
      if (entry.type === 'upload') {
        const key = keyFor('attachment', entry.id)
        if (!this.records.has(key))
          this.records.set(key, { kind: 'attachment', id: entry.id, data: { id: entry.id, reminder_id: entry.reminder_id, name: entry.name, mime: entry.mime, size: entry.size, hash: '', created_by: this.me?.account.id ?? null, created_at: '' }, clock: {} })
        continue
      }
      const op = entry.op
      if (op.type === 'put') {
        const key = keyFor(op.kind, op.id)
        let rec = this.records.get(key)
        if (!rec) {
          const made = fresh(op.kind, op.id)
          rec = { kind: op.kind, id: op.id, data: made.data, clock: made.clock }
          if (op.fields.created_at) rec.data.created_at = op.fields.created_at
          this.records.set(key, rec)
        }
        mergeInto(op.kind, rec.data, rec.clock, op.fields, op.clock)
      } else if (op.type === 'delete') this.records.delete(keyFor(op.kind, op.id))
      else if (op.type === 'complete') this.completeLocally(op)
      else {
        const me = this.me?.account.id ?? 0
        const id = `${op.space_id}:${me}`
        const rec = this.records.get(keyFor('member', id))
        if (rec) rec.data.position = op.position
      }
    }
  }

  /** The view of this moment, also in the middle of a change (the cached one follows `version`). */
  private current(): View {
    this.cachedView = null
    return this.view()
  }

  /** Keys of records an own change still waits for. */
  private pendingKeys(): Set<string> {
    const keys = new Set<string>()
    for (const entry of this.queue.entries) {
      if (entry.type === 'upload') {
        keys.add(keyFor('attachment', entry.id))
        continue
      }
      const op = entry.op
      if (op.type === 'put' || op.type === 'delete') keys.add(keyFor(op.kind, op.id))
      if (op.type === 'complete') {
        keys.add(keyFor('reminder', op.id))
        if (op.occurrence) keys.add(keyFor('reminder', copyId(op.id, op.occurrence)))
      }
      if (op.type === 'position') keys.add(keyFor('member', `${op.space_id}:${this.me?.account.id}`))
    }
    return keys
  }

  /** Spaces the server no longer lists go with everything in them; own changes in them become copies in "Privat". */
  private spacesLeft(spaceIds: string[]): void {
    this.spaceIds = spaceIds
    const keep = new Set(spaceIds)
    const waiting = this.pendingKeys()
    const gone = [...this.records.values()].filter((r) => r.kind === 'space' && !keep.has(r.id) && !waiting.has(keyFor('space', r.id)))
    if (!gone.length) return
    const goneSpaces = new Set(gone.map((s) => s.id))
    const lists = new Set([...this.records.values()].filter((r) => r.kind === 'list' && goneSpaces.has(r.data.space_id as string)).map((r) => r.id))
    const reminders = [...this.records.values()].filter((r) => r.kind === 'reminder' && lists.has(r.data.list_id as string))
    const reminderIds = new Set(reminders.map((r) => r.id))
    const doomed = new Set<string>()
    for (const rec of this.records.values()) {
      const d = rec.data
      if (
        (rec.kind === 'space' && goneSpaces.has(rec.id)) ||
        (rec.kind === 'member' && goneSpaces.has(d.space_id as string)) ||
        (rec.kind === 'list' && lists.has(rec.id)) ||
        (rec.kind === 'list_pref' && lists.has(rec.id)) ||
        (rec.kind === 'space_pref' && goneSpaces.has(rec.id)) ||
        (rec.kind === 'section' && lists.has(d.list_id as string)) ||
        (rec.kind === 'reminder' && reminderIds.has(rec.id)) ||
        (rec.kind === 'attachment' && reminderIds.has(d.reminder_id as string))
      )
        doomed.add(keyFor(rec.kind, rec.id))
    }
    // Own changes waiting in there: the reminders they touch come along as copies with new ids.
    const touched = reminders.filter((r) => waiting.has(keyFor('reminder', r.id)))
    const target = this.current().firstPrivateList
    const copies = touched.length && target ? touched.map((r) => ({ ...r.data })) : []
    this.queue.entries = this.queue.entries.filter((entry) => {
      if (entry.type === 'upload') return !doomed.has(keyFor('reminder', entry.reminder_id))
      const op = entry.op
      if (op.type === 'complete') return !doomed.has(keyFor('reminder', op.id))
      if (op.type === 'position') return !goneSpaces.has(op.space_id)
      return !doomed.has(keyFor(op.kind, op.id))
    })
    this.queue.save()
    for (const key of doomed) this.records.delete(key)
    if (copies.length && target) {
      const fresh = new Map(copies.map((c) => [c.id as string, uuid4()]))
      for (const copy of copies) {
        const fields: Data = { ...copy }
        delete fields.id
        delete fields.created_by
        delete fields.completed_by
        fields.list_id = target.id
        fields.section_id = null
        fields.parent_id = copy.parent_id && fresh.has(copy.parent_id as string) ? fresh.get(copy.parent_id as string) : null
        fields.position = keyAtEnd(this.current().live.filter((r) => r.list_id === target.id && !r.parent_id))
        fields.completed_at = null
        fields.assignees = []
        this.put('reminder', fresh.get(copy.id as string)!, fields, true)
      }
      this.notice('space_left_copied', { count: copies.length, list: target.name })
    } else if (gone.length) this.notice('space_left', { name: gone[0].data.name })
  }

  // ---- Own changes --------------------------------------------------------------------------------------------------

  /**
   * Changes or makes a record: every touched group is sent whole, each key with the clock of now (never below the
   * one it has, so the later change wins locally too). `creating` sends the record whole.
   */
  put(kind: PutOp['kind'], id: string, change: Data, creating = false): void {
    const key = keyFor(kind, id)
    let rec = this.records.get(key)
    const isNew = !rec
    if (!rec) {
      const made = fresh(kind, id)
      rec = { kind, id, data: made.data, clock: made.clock }
      if (kind === 'reminder') {
        rec.data.created_at = this.nowIso()
        rec.data.created_by = this.me?.account.id ?? null
      }
      this.records.set(key, rec)
    }
    const fields: Data = {}
    for (const [field, value] of Object.entries(change)) fields[field] = normalize(field, value)
    const now = this.now()
    const opFields: Data = {}
    const opClock: Record<string, number> = {}
    const keys = new Set<string>()
    for (const field of Object.keys(fields)) {
      const clockKey = keyOf(kind, field)
      if (clockKey) keys.add(clockKey)
    }
    if (isNew || creating) for (const field of REQUIRED[kind] ?? []) keys.add(keyOf(kind, field) ?? field)
    for (const clockKey of keys) {
      for (const field of fieldsOf(kind, clockKey)) opFields[field] = field in fields ? fields[field] : (rec.data[field] ?? null)
      opClock[clockKey] = Math.max(now, (rec.clock[clockKey] ?? 0) + 1)
    }
    if ((isNew || creating) && kind === 'reminder') opFields.created_at = rec.data.created_at
    for (const [field, value] of Object.entries(opFields)) rec.data[field] = structuredClone(value)
    for (const [clockKey, time] of Object.entries(opClock)) rec.clock[clockKey] = time
    if (!Object.keys(opClock).length && !isNew) return this.bump()
    this.enqueue({ op_id: uuid4(), type: 'put', kind, id, fields: opFields, clock: opClock })
  }

  private enqueue(op: Op): void {
    const last = this.queue.entries.at(-1)
    // Typing in a field makes many small changes: one waiting op per record is enough.
    if (op.type === 'put' && last?.type === 'op' && last.op.type === 'put' && last.op.kind === op.kind && last.op.id === op.id && !this.inFlight.has(last.op.op_id)) {
      Object.assign(last.op.fields, op.fields)
      Object.assign(last.op.clock, op.clock)
      this.queue.save()
    } else this.queue.push({ type: 'op', op })
    this.bump()
    this.soon()
  }

  private soon(): void {
    this.later(0, () => void this.flush())
  }

  /** Into the trash, or back (`deleted_at` on the record itself). */
  trash(kind: 'space' | 'list' | 'reminder', id: string, back = false): void {
    this.put(kind, id, { deleted_at: back ? null : this.nowIso() })
  }

  /** For good: sections, attachments and own filters. */
  remove(kind: 'section' | 'attachment' | 'filter', id: string): void {
    this.records.delete(keyFor(kind, id))
    this.enqueue({ op_id: uuid4(), type: 'delete', kind, id })
  }

  /** Ticks a reminder off, or opens it again. */
  toggle(id: string): void {
    const reminder = this.view().reminder(id)
    if (!reminder) return
    if (reminder.completed_at) {
      this.put('reminder', id, { completed_at: null, completed_by: null })
      return
    }
    const op: CompleteOp = { op_id: uuid4(), type: 'complete', id, occurrence: reminder.due_date, at: this.nowIso(), on: this.today() }
    this.completeLocally(op)
    this.enqueue(op)
  }

  private world(): CompleteWorld {
    const get = (id: string): Stored | undefined => this.records.get(keyFor('reminder', id))
    return {
      reminder: get,
      children: (id) => [...this.records.values()].filter((r) => r.kind === 'reminder' && r.data.parent_id === id),
      save: (id, record) => {
        const existing = get(id)
        if (existing) {
          existing.data = record.data
          existing.clock = record.clock
        } else this.records.set(keyFor('reminder', id), { kind: 'reminder', id, data: record.data, clock: record.clock })
      },
    }
  }

  /** The picture of an own `complete` before the server confirms it. */
  private completeLocally(op: CompleteOp): void {
    const world = this.world()
    const rec = world.reminder(op.id)
    if (!rec) return
    if (op.occurrence && world.reminder(copyId(op.id, op.occurrence))) return
    if (!rec.data.repeat && rec.data.completed_at) return
    applyComplete(world, op.id, op.occurrence, op.at, op.on, this.me?.account.id ?? null)
  }

  /** The own order of a space in the sidebar. */
  setSpacePosition(spaceId: string, position: string | null): void {
    const me = this.me?.account.id ?? 0
    const id = `${spaceId}:${me}`
    const key = keyFor('member', id)
    const rec = this.records.get(key) ?? { kind: 'member' as const, id, data: { space_id: spaceId, account_id: me, role: 'member', position: null }, clock: {} }
    rec.data.position = position
    this.records.set(key, rec)
    this.enqueue({ op_id: uuid4(), type: 'position', space_id: spaceId, position })
  }

  /** A file for a reminder: shown at once, sent after the reminder itself is confirmed (queue order). */
  async attach(reminderId: string, file: File | Blob, name: string): Promise<string> {
    const id = uuid4()
    const entry: UploadEntry = { type: 'upload', op_id: uuid4(), id, reminder_id: reminderId, name, mime: file.type || 'application/octet-stream', size: file.size }
    await this.blobs.put(entry.op_id, file)
    this.records.set(keyFor('attachment', id), {
      kind: 'attachment',
      id,
      data: { id, reminder_id: reminderId, name, mime: entry.mime, size: file.size, hash: '', created_by: this.me?.account.id ?? null, created_at: this.nowIso() },
      clock: {},
    })
    this.queue.push(entry)
    this.bump()
    this.soon()
    return id
  }

  /** Whether a record still waits for the server (shown as "not sent yet"). */
  waiting(kind: Kind, id: string): boolean {
    return this.pendingKeys().has(keyFor(kind, id))
  }

  // ---- Sending ------------------------------------------------------------------------------------------------------

  /** Sends the queue: ops in batches, an upload ends the running batch. */
  flush(): Promise<void> {
    if (this.sending) return this.sending
    if (this.stopped || this.status === 'signedOut' || this.status === 'loading') return Promise.resolve()
    const wait = this.haltedUntil - this.localClock()
    if (wait > 0) return Promise.resolve()
    this.sending = (async () => {
      // First let the assignment happen: a run that finds nothing to do must still clear it afterwards.
      await null
      try {
        while (this.queue.length && !this.stopped && this.haltedUntil <= this.localClock()) {
          const head = this.queue.entries[0]
          const ok = head.type === 'upload' ? await this.sendUpload(head) : await this.sendBatch()
          if (!ok) break
        }
      } finally {
        this.sending = null
        this.bump()
      }
    })()
    return this.sending
  }

  private async sendBatch(): Promise<boolean> {
    const batch: OpEntry[] = []
    const limit = this.solo ? 1 : this.batchSize
    for (const entry of this.queue.entries) {
      if (entry.type !== 'op' || batch.length >= limit) break
      batch.push(entry)
    }
    for (const entry of batch) this.inFlight.add(entry.op.op_id)
    try {
      const answer = await this.transport.json<{ results: Result[]; cursor: number }>('POST', '/batch', { ops: batch.map((e) => e.op) })
      this.passed()
      const byId = new Map(answer.results.map((r) => [r.op_id, r]))
      let all = true
      for (const entry of batch) {
        const result = byId.get(entry.op.op_id)
        if (result) this.handle(entry, result)
        else all = false
      }
      this.solo = false
      // An op without its result stays; it goes again with the next round, not in a loop now.
      return all
    } catch (error) {
      return this.failed(error, batch)
    } finally {
      for (const entry of batch) this.inFlight.delete(entry.op.op_id)
      this.bump()
    }
  }

  private async sendUpload(entry: UploadEntry): Promise<boolean> {
    const blob = await this.blobs.get(entry.op_id)
    if (!blob) {
      // The file did not survive (a reload in a browser without IndexedDB): the attachment cannot go.
      this.queue.remove(entry.op_id)
      this.records.delete(keyFor('attachment', entry.id))
      this.notice('upload_lost', { name: entry.name })
      return true
    }
    const form = new FormData()
    form.append('id', entry.id)
    form.append('reminder_id', entry.reminder_id)
    form.append('op_id', entry.op_id)
    form.append('file', new File([blob], entry.name, { type: entry.mime }))
    try {
      const result = await this.transport.upload<Result>('/files', form)
      this.passed()
      this.handle(entry, result)
      return true
    } catch (error) {
      return this.failed(error, [entry])
    }
  }

  private passed(): void {
    this.backoff = 0
    if (this.status === 'offline') this.status = 'ready'
  }

  /** What a refused or lost request means for the queue (contract, last rows of the table). */
  private failed(error: unknown, entries: Entry[]): boolean {
    if (!(error instanceof AppError)) throw error
    if (error.status === 401) {
      this.signedOut()
      return false
    }
    if (error.passing || (error.status === 403 && error.code === 'app_disabled')) {
      this.backoff = error.retryAfter ? error.retryAfter * 1000 : Math.min(MAX_BACKOFF, this.backoff ? this.backoff * 2 : 2000)
      this.haltedUntil = this.localClock() + this.backoff
      if (error.status === 0) this.status = 'offline'
      this.later(this.backoff, () => void this.flush())
      return false
    }
    // The whole request was refused (too large, unreadable): one at a time finds the one at fault.
    if (entries.length > 1) {
      this.solo = true
      return true
    }
    const entry = entries[0]
    this.queue.remove(entryId(entry))
    if (entry.type === 'upload') this.records.delete(keyFor('attachment', entry.id))
    this.notice(error.code)
    this.solo = false
    return true
  }

  /** One `Result` (contract, table "Was die App bzw. das Web nach einem Result tut"). */
  private handle(entry: Entry, result: Result): void {
    // Already taken out (a parent moved to "Privat" took its subtasks' ops along in the same batch).
    if (!this.queue.entries.includes(entry)) return
    if (!result.ok && result.code === 'parent_missing' && entry.type === 'op') return this.parentMissing(entry)
    this.queue.remove(entryId(entry))
    const op = entry.type === 'op' ? entry.op : null
    if (result.ok) {
      if (result.current) this.receive(result.current)
      if (result.copy) this.receive(result.copy)
      if (result.dropped_assignees?.length) this.notice('dropped_assignees', { count: result.dropped_assignees.length })
      return
    }
    const code = result.code ?? 'invalid'
    if (op?.type === 'complete' && (code === 'already_done' || code === 'due_changed') && op.occurrence) {
      // The own copy goes; a copy the server has comes with `copy` or with the next changes.
      this.records.delete(keyFor('reminder', copyId(op.id, op.occurrence)))
    }
    if (result.copy) this.receive(result.copy)
    if (result.current) this.receive(result.current)
    else if (op && op.type !== 'position') this.records.delete(keyFor(op.type === 'complete' ? 'reminder' : op.kind, op.id))
    else if (entry.type === 'upload') this.records.delete(keyFor('attachment', entry.id))
    if (code === 'gone' && op && op.type !== 'position') this.records.delete(keyFor(op.type === 'complete' ? 'reminder' : op.kind, op.id))
    // Unknown codes count like `invalid`: the op leaves, what the server holds stands.
    this.notice(FINAL.has(code) ? code : 'invalid')
  }

  /**
   * The parent the op points to is unknown to the server. While the parent's own op still waits, the op goes after it
   * (three times at most); otherwise the record and its subtasks go into the first list of "Privat" as new ops.
   */
  private parentMissing(entry: OpEntry): void {
    const op = entry.op as PutOp
    const rec = this.records.get(keyFor(op.kind, op.id))
    const refs = new Set([op.fields.list_id, op.fields.parent_id, op.fields.space_id, rec?.data.list_id, rec?.data.parent_id, rec?.data.space_id].filter((v): v is string => typeof v === 'string'))
    // A space setting waits for its space (same id, another kind).
    if (op.kind === 'space_pref') refs.add(op.id)
    const index = this.queue.entries.findIndex((e) => e !== entry && e.type === 'op' && e.op.type === 'put' && !(e.op.kind === op.kind && e.op.id === op.id) && refs.has(e.op.id))
    if (index >= 0 && (entry.tries ?? 0) < 3) {
      const entries = this.queue.entries.filter((e) => e !== entry)
      const at = entries.findIndex((e) => e.type === 'op' && e.op.type === 'put' && !(e.op.kind === op.kind && e.op.id === op.id) && refs.has(e.op.id))
      // Vertragslücke: the server keeps the result of an op_id (parent_missing), so the op goes again under a new one.
      entries.splice(at + 1, 0, { type: 'op', op: { ...op, op_id: uuid4() }, tries: (entry.tries ?? 0) + 1 })
      this.queue.entries = entries
      this.queue.save()
      return
    }
    this.queue.remove(op.op_id)
    if (!rec) return
    const view = this.current()
    if (op.kind === 'reminder') {
      const target = view.firstPrivateList
      if (!target) return this.notice('parent_missing')
      const family = [rec, ...[...this.records.values()].filter((r) => r.kind === 'reminder' && r.data.parent_id === rec.id)]
      const ids = new Set(family.map((r) => r.id))
      // Their other waiting changes would only meet the same refusal.
      this.queue.entries = this.queue.entries.filter((e) => !(e.type === 'op' && e.op.type === 'put' && e.op.kind === 'reminder' && ids.has(e.op.id)))
      this.queue.save()
      const position = keyAtEnd(view.live.filter((r) => r.list_id === target.id && !r.parent_id))
      for (const member of family) {
        const fields: Data = { ...member.data }
        delete fields.id
        fields.list_id = target.id
        fields.section_id = null
        if (member === rec) {
          fields.parent_id = null
          fields.position = position
        }
        fields.assignees = []
        this.put('reminder', member.id, fields, true)
      }
      this.notice('moved_to_private', { list: target.name })
    } else if (op.kind === 'list' && view.privateSpace) {
      const fields: Data = { ...rec.data, space_id: view.privateSpace.id, position: keyAtEnd(view.listsOf(view.privateSpace.id)) }
      delete fields.id
      this.put('list', rec.id, fields, true)
      this.notice('moved_to_private', { list: view.privateSpace.name })
    } else {
      this.records.delete(keyFor(op.kind, op.id))
      this.notice('parent_missing')
    }
  }

  // ---- Calls that need the network -----------------------------------------------------------------------------------

  /** A call outside the queue (members, invitations); afterwards the news are fetched. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const answer = await this.transport.json<T>(method, path, body)
    await this.pull()
    return answer
  }
}

/** Texts as stored: NFC, trimmed; tags cleaned. */
function normalize(field: string, value: unknown): unknown {
  if (typeof value === 'string' && ['title', 'name', 'notes', 'url'].includes(field)) {
    const text = cleanText(value)
    return field === 'url' && !text ? null : text
  }
  if (field === 'tags' && Array.isArray(value)) return cleanTags(value as string[])
  return value
}

export type { Reminder }
