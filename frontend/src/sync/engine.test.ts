// The web's sync against the fake server: fetching page by page, the rule per field, the queue and what each result
// code does with it, the queue across a reload, 410, spaces that go away, files, complete with repetition.
import { afterEach, describe, expect, it } from 'vitest'

import { FakeServer, smallWorld } from '../test/fakeServer'
import { SyncEngine, type EngineOptions } from './engine'
import { memoryBlobs, memoryStorage, type KeyValue } from './queue'
import { httpTransport } from './transport'
import { uuid4 } from './uuid'

const engines: SyncEngine[] = []
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
})

function client(server: FakeServer, account: number, options: Partial<EngineOptions> & { storage?: KeyValue } = {}): SyncEngine {
  const engine = new SyncEngine({ transport: httpTransport(server.fetcher(account)), storage: memoryStorage(), blobs: memoryBlobs(), today: () => '2026-11-06', ...options })
  engines.push(engine)
  return engine
}

async function quiet(...clients: SyncEngine[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (const c of clients) await c.flush()
    for (const c of clients) await c.pull()
  }
}

function title(engine: SyncEngine, id: string): string | undefined {
  return engine.view().reminder(id)?.title
}

describe('fetching', () => {
  it('loads every space, list and reminder the account sees, page by page', async () => {
    const { server, robin, home } = smallWorld()
    for (let i = 0; i < 30; i++) server.addReminder(home, `Item ${i}`)
    const outsider = server.addAccount('Sam')
    server.addReminder(server.addList(server.addSpace('Elsewhere', outsider), 'Theirs'), 'Not for Robin')
    const engine = client(server, robin, { pageSize: 7 })
    await engine.start()
    const view = engine.view()
    expect(view.spaces.map((s) => s.name)).toEqual(['Private', 'Family'])
    expect(view.live.filter((r) => r.list_id === home)).toHaveLength(30)
    expect(view.live.some((r) => r.title === 'Not for Robin')).toBe(false)
    expect(server.requests.filter((r) => r.path.startsWith('/api/app/1/changes')).length).toBeGreaterThan(4)
    expect(engine.cursor).toBe(server.cursor)
    expect(view.people.get(robin)?.name).toBe('Robin')
  })

  it('learns the distance to the server clock from /me', async () => {
    const { server, robin } = smallWorld()
    server.clock = () => Date.parse('2026-11-06T12:00:00.000Z')
    const engine = client(server, robin, { clock: () => Date.parse('2026-11-06T11:59:00.000Z') })
    await engine.start()
    expect(Math.abs(engine.now() - Date.parse('2026-11-06T12:00:00.000Z'))).toBeLessThan(5)
  })

  it('answers 410 with a full load that drops what did not come, but keeps own waiting changes', async () => {
    const { server, robin, home } = smallWorld()
    const gone = server.addReminder(home, 'Quietly gone')
    const engine = client(server, robin)
    await engine.start()
    expect(title(engine, gone)).toBe('Quietly gone')
    // The server forgot its tombstones: a record vanished without a trace.
    server.rows.delete(`reminder:${gone}`)
    server.oldest = server.cursor + 1
    server.fail('POST /api/app/1/batch', 503, 'internal_error')
    const mine = uuid4()
    engine.put('reminder', mine, { list_id: home, title: 'Mine, not sent', position: 'a5' })
    await engine.flush()
    server.addReminder(home, 'New one')
    server.oldest = server.cursor
    await engine.pull()
    expect(title(engine, gone)).toBeUndefined()
    expect(title(engine, mine)).toBe('Mine, not sent')
    expect(engine.view().live.some((r) => r.title === 'New one')).toBe(true)
    expect(server.requests.some((r) => r.path.includes('since=0'))).toBe(true)
  })

  it('removes a space the account left, with everything in it', async () => {
    const { server, robin, alex, family, home } = smallWorld()
    server.addReminder(home, 'Shared')
    const engine = client(server, alex)
    await engine.start()
    expect(engine.view().space(family)).toBeDefined()
    server.leave(family, alex)
    await engine.pull()
    expect(engine.view().space(family)).toBeUndefined()
    expect(engine.view().list(home)).toBeUndefined()
    expect([...engine.records.values()].some((r) => r.kind === 'reminder' && r.data.title === 'Shared')).toBe(false)
    expect(robin).toBe(1)
  })

  it('keeps own waiting changes of a space it lost as copies in "Private"', async () => {
    const { server, alex, family, home } = smallWorld()
    const shared = server.addReminder(home, 'Shared')
    const engine = client(server, alex)
    await engine.start()
    server.fail('POST /api/app/1/batch', 503, 'internal_error')
    engine.put('reminder', shared, { title: 'Shared, edited offline' })
    await engine.flush()
    server.leave(family, alex)
    await engine.pull()
    const copy = engine.view().live.find((r) => r.title === 'Shared, edited offline')
    expect(copy).toBeDefined()
    expect(copy!.id).not.toBe(shared)
    expect(copy!.list_id).toBe(engine.view().firstPrivateList!.id)
    expect(engine.notices.map((n) => n.code)).toContain('space_left_copied')
  })
})

describe('the rule per field', () => {
  it('keeps changes to different fields from two browsers', async () => {
    const { server, robin, alex, home } = smallWorld()
    const id = server.addReminder(home, 'Milk')
    const a = client(server, robin)
    const b = client(server, alex)
    await a.start()
    await b.start()
    a.put('reminder', id, { title: 'Oat milk' })
    b.put('reminder', id, { flagged: true, priority: 2 })
    await quiet(a, b)
    for (const c of [a, b]) expect(c.view().reminder(id)).toMatchObject({ title: 'Oat milk', flagged: true, priority: 2 })
    expect(server.data('reminder', id)).toMatchObject({ title: 'Oat milk', flagged: true, priority: 2 })
  })

  it('lets the later change of the same field win, whoever sends last', async () => {
    const { server, robin, alex, home } = smallWorld()
    const id = server.addReminder(home, 'Milk')
    let t = Date.parse('2026-11-06T10:00:00.000Z')
    server.clock = () => t
    const a = client(server, robin, { clock: () => t })
    const b = client(server, alex, { clock: () => t })
    await a.start()
    await b.start()
    t += 1000
    a.put('reminder', id, { title: 'Earlier' })
    t += 1000
    b.put('reminder', id, { title: 'Later' })
    await b.flush()
    await a.flush()
    await quiet(a, b)
    expect(server.data('reminder', id)!.title).toBe('Later')
    expect(title(a, id)).toBe('Later')
  })

  it('decides a tie of clocks by the canonical value, the same on both sides', async () => {
    const { server, robin, alex, home } = smallWorld()
    const id = server.addReminder(home, 'Milk')
    const t = Date.parse('2026-11-06T10:00:00.000Z')
    server.clock = () => t
    const a = client(server, robin, { clock: () => t })
    const b = client(server, alex, { clock: () => t })
    await a.start()
    await b.start()
    a.put('reminder', id, { title: 'Apples' })
    b.put('reminder', id, { title: 'Bananas' })
    await a.flush()
    await b.flush()
    await quiet(a, b)
    expect(server.data('reminder', id)!.title).toBe('Bananas')
    expect(title(a, id)).toBe('Bananas')
    expect(title(b, id)).toBe('Bananas')
  })

  it('sends a whole group: changing the time sends date, time, repetition and its base', async () => {
    const { server, robin, home } = smallWorld()
    const id = server.addReminder(home, 'Call', { due_date: '2026-11-10' })
    const engine = client(server, robin)
    await engine.start()
    engine.put('reminder', id, { due_time: '09:30' })
    await engine.flush()
    const batch = server.requests.find((r) => r.path === '/api/app/1/batch')!.body as { ops: { fields: Record<string, unknown>; clock: Record<string, number> }[] }
    expect(batch.ops[0].fields).toEqual({ due_date: '2026-11-10', due_time: '09:30', repeat: null, repeat_from: 'due' })
    expect(Object.keys(batch.ops[0].clock)).toEqual(['due'])
  })

  it('keeps an own change that waits on top of an older entry from the server', async () => {
    const { server, robin, home } = smallWorld()
    const id = server.addReminder(home, 'Milk')
    let t = Date.parse('2026-11-06T10:00:00.000Z')
    server.clock = () => t
    const engine = client(server, robin, { clock: () => t })
    await engine.start()
    server.fail('POST /api/app/1/batch', 503, 'internal_error')
    t += 5000
    engine.put('reminder', id, { title: 'Mine' })
    await engine.flush()
    // Another device changed the title earlier (older clock) and the notes; the entry arrives now.
    server.change('reminder', id, { title: 'Theirs', notes: 'From the phone' }, t - 3000)
    await engine.pull()
    expect(engine.view().reminder(id)).toMatchObject({ title: 'Mine', notes: 'From the phone' })
  })
})

describe('the queue', () => {
  it('sends own changes in one batch, and keeps nothing after the results', async () => {
    const { server, robin, home } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    const ids = [uuid4(), uuid4(), uuid4()]
    ids.forEach((id, i) => engine.put('reminder', id, { list_id: home, title: `R${i}`, position: `a${i + 1}` }))
    await engine.flush()
    expect(server.requests.filter((r) => r.path === '/api/app/1/batch')).toHaveLength(1)
    expect(engine.queue.length).toBe(0)
    for (const id of ids) expect(server.data('reminder', id)).toBeDefined()
  })

  it('merges quick edits of one record into one waiting op', async () => {
    const { server, robin, home } = smallWorld()
    const id = server.addReminder(home, 'M')
    const engine = client(server, robin)
    await engine.start()
    server.fail('POST /api/app/1/batch', 503, 'internal_error')
    for (const text of ['Mi', 'Mil', 'Milk']) engine.put('reminder', id, { title: text })
    await engine.flush()
    expect(engine.queue.length).toBe(1)
  })

  it('survives a reload: the next page start shows and sends what waited', async () => {
    const { server, robin, home } = smallWorld()
    const storage = memoryStorage()
    const first = client(server, robin, { storage })
    await first.start()
    server.fail('POST /api/app/1/batch', 503, 'internal_error')
    const id = uuid4()
    first.put('reminder', id, { list_id: home, title: 'Written offline', position: 'a1' })
    await first.flush()
    first.stop()
    expect(server.data('reminder', id)).toBeUndefined()

    const second = client(server, robin, { storage })
    await second.start()
    expect(title(second, id)).toBe('Written offline')
    await second.flush()
    expect(server.data('reminder', id)!.title).toBe('Written offline')
    expect(second.queue.length).toBe(0)
  })

  it('stops the whole queue on 429 and waits Retry-After', async () => {
    const { server, robin, home } = smallWorld()
    let t = 1_000_000
    const engine = client(server, robin, { clock: () => t })
    await engine.start()
    server.fail('POST /api/app/1/batch', 429, 'too_many', 1, 30)
    engine.put('reminder', uuid4(), { list_id: home, title: 'A', position: 'a1' })
    await engine.flush()
    expect(engine.queue.length).toBe(1)
    t += 10_000
    await engine.flush()
    expect(server.requests.filter((r) => r.path === '/api/app/1/batch')).toHaveLength(1)
    t += 21_000
    await engine.flush()
    expect(engine.queue.length).toBe(0)
  })

  it('backs off on 5xx and when the network is gone, longer each time', async () => {
    const { server, robin, home } = smallWorld()
    let t = 1_000_000
    const engine = client(server, robin, { clock: () => t })
    await engine.start()
    server.fail('POST /api/app/1/batch', 502, 'internal_error', 2)
    engine.put('reminder', uuid4(), { list_id: home, title: 'A', position: 'a1' })
    await engine.flush()
    t += 2_001
    await engine.flush()
    t += 2_001
    await engine.flush()
    expect(engine.queue.length).toBe(1)
    t += 2_000
    await engine.flush()
    expect(engine.queue.length).toBe(0)
  })

  it('keeps the queue on 401 and says the session is gone', async () => {
    const { server, robin, home } = smallWorld()
    let gone = 0
    const engine = client(server, robin, { onSignedOut: () => gone++ })
    await engine.start()
    server.fail('POST /api/app/1/batch', 401, 'not_signed_in')
    engine.put('reminder', uuid4(), { list_id: home, title: 'A', position: 'a1' })
    await engine.flush()
    expect(gone).toBe(1)
    expect(engine.queue.length).toBe(1)
    expect(engine.status).toBe('signedOut')
  })

  it('finds the op at fault one by one when the whole batch is refused', async () => {
    const { server, robin, home } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    server.fail('POST /api/app/1/batch', 413, 'too_large')
    server.fail('POST /api/app/1/batch', 413, 'too_large')
    const a = uuid4()
    const b = uuid4()
    engine.put('reminder', a, { list_id: home, title: 'A', position: 'a1' })
    engine.put('reminder', b, { list_id: home, title: 'B', position: 'a2' })
    await engine.flush()
    expect(engine.queue.length).toBe(0)
    expect(server.data('reminder', b)).toBeDefined()
    expect(engine.notices.map((n) => n.code)).toContain('too_large')
  })
})

describe('what each result does', () => {
  it('forbidden: the op goes, the server state stands, a notice says why', async () => {
    const { server, alex, family } = smallWorld()
    const engine = client(server, alex)
    await engine.start()
    engine.put('space', family, { name: 'Renamed by a member' })
    expect(engine.view().space(family)?.name).toBe('Renamed by a member')
    await engine.flush()
    expect(engine.view().space(family)?.name).toBe('Family')
    expect(engine.queue.length).toBe(0)
    expect(engine.notices.at(-1)?.code).toBe('forbidden')
  })

  it('not_found without current: the record goes locally', async () => {
    const { server, robin } = smallWorld()
    const sam = server.addAccount('Sam')
    const theirs = server.addSpace('Theirs', sam)
    const engine = client(server, robin)
    await engine.start()
    engine.put('list', uuid4(), { space_id: theirs, name: 'Sneaky', position: 'a1' })
    await engine.flush()
    expect(engine.view().spaces.some((s) => s.id === theirs)).toBe(false)
    expect([...engine.records.values()].some((r) => r.kind === 'list' && r.data.name === 'Sneaky')).toBe(false)
    expect(engine.notices.at(-1)?.code).toBe('not_found')
  })

  it('invalid: the op goes and what the server holds comes back', async () => {
    const { server, robin, home } = smallWorld()
    const id = server.addReminder(home, 'Good')
    const engine = client(server, robin)
    await engine.start()
    engine.put('reminder', id, { url: 'javascript:alert(1)' })
    await engine.flush()
    expect(engine.view().reminder(id)?.url).toBeNull()
    expect(engine.notices.at(-1)?.code).toBe('invalid')
  })

  it('gone: the op and the local record go', async () => {
    const { server, robin, home } = smallWorld()
    const section = server.addSection(home, 'Later', 'a0')
    const engine = client(server, robin)
    await engine.start()
    server.bury('section', section)
    server.fail('GET /api/app/1/changes', 503, 'internal_error')
    engine.put('section', section, { name: 'Renamed' })
    await engine.flush()
    expect(engine.view().section(section)).toBeUndefined()
    expect(engine.notices.at(-1)?.code).toBe('gone')
  })

  it('parent_missing: goes again after the parent that still waits', async () => {
    const { server, robin, family } = smallWorld()
    const engine = client(server, robin, { batchSize: 1 })
    await engine.start()
    const list = uuid4()
    const reminder = uuid4()
    // The reminder is queued before its list (as after a reordering of the queue).
    engine.put('reminder', reminder, { list_id: list, title: 'Child first', position: 'a1' })
    engine.put('list', list, { space_id: family, name: 'Parent later', position: 'a5' })
    await engine.flush()
    expect(server.data('list', list)).toBeDefined()
    expect(server.data('reminder', reminder)?.list_id).toBe(list)
    expect(engine.queue.length).toBe(0)
  })

  it('parent_missing without a waiting parent: into the first list of "Private", subtasks along', async () => {
    const { server, robin, privateList } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    const nowhere = uuid4()
    // A list only this browser knew and lost (as after clearing site data in another tab).
    engine.records.set(`list:${nowhere}`, { kind: 'list', id: nowhere, data: { id: nowhere, space_id: engine.view().privateSpace!.id, name: 'Lost', color: 'blue', icon: 'list', view: 'list', position: 'a9', deleted_at: null }, clock: {} })
    const parent = uuid4()
    const child = uuid4()
    engine.put('reminder', parent, { list_id: nowhere, title: 'Parent', position: 'a1' })
    engine.put('reminder', child, { list_id: nowhere, parent_id: parent, title: 'Child', position: 'a1' })
    await engine.flush()
    await engine.flush()
    expect(server.data('reminder', parent)?.list_id).toBe(privateList)
    expect(server.data('reminder', child)).toMatchObject({ list_id: privateList, parent_id: parent })
    expect(engine.notices.map((n) => n.code)).toContain('moved_to_private')
  })

  it('reports assignees the server dropped', async () => {
    const { server, robin, home } = smallWorld()
    const outsider = server.addAccount('Sam')
    const engine = client(server, robin)
    await engine.start()
    const id = uuid4()
    engine.put('reminder', id, { list_id: home, title: 'Who?', position: 'a1', assignees: [robin, outsider] })
    await engine.flush()
    expect(engine.view().reminder(id)?.assignees).toEqual([robin])
    expect(engine.notices.at(-1)).toMatchObject({ code: 'dropped_assignees', values: { count: 1 } })
  })
})

describe('completing', () => {
  it('ticks off with its open subtasks, and opens only itself again', async () => {
    const { server, robin, home } = smallWorld()
    const parent = server.addReminder(home, 'Trip')
    const sub = server.addReminder(home, 'Pack', { parent_id: parent })
    const engine = client(server, robin)
    await engine.start()
    engine.toggle(parent)
    expect(engine.view().reminder(sub)?.completed_at).not.toBeNull()
    await quiet(engine)
    expect(server.data('reminder', parent)?.completed_by).toBe(robin)
    expect(server.data('reminder', sub)?.completed_at).not.toBeNull()
    engine.toggle(parent)
    await quiet(engine)
    expect(server.data('reminder', parent)?.completed_at).toBeNull()
    expect(server.data('reminder', sub)?.completed_at).not.toBeNull()
  })

  it('makes the done copy of a repeated reminder at once, with the id the server computes', async () => {
    const { server, robin, home } = smallWorld()
    const id = server.addReminder(home, 'Bins', { due_date: '2026-11-06', repeat: 'FREQ=WEEKLY;BYDAY=FR' })
    const engine = client(server, robin)
    await engine.start()
    engine.toggle(id)
    const local = engine.view().reminders.find((r) => r.completed_at && r.title === 'Bins')
    expect(engine.view().reminder(id)?.due_date).toBe('2026-11-13')
    await quiet(engine)
    const remote = [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === 'Bins' && r.data.completed_at)
    expect(remote?.id).toBe(local?.id)
    expect(engine.view().reminders.filter((r) => r.title === 'Bins')).toHaveLength(2)
  })

  it('already_done: the second browser drops its own copy and takes the server state', async () => {
    const { server, robin, alex, home } = smallWorld()
    const id = server.addReminder(home, 'Bins', { due_date: '2026-11-06', repeat: 'FREQ=WEEKLY;BYDAY=FR' })
    const a = client(server, robin)
    const b = client(server, alex)
    await a.start()
    await b.start()
    a.toggle(id)
    b.toggle(id)
    await a.flush()
    await b.flush()
    expect(b.notices.at(-1)?.code).toBe('already_done')
    await quiet(a, b)
    expect(b.view().reminders.filter((r) => r.title === 'Bins')).toHaveLength(2)
    expect(b.view().reminder(id)?.due_date).toBe('2026-11-13')
  })

  it('due_changed: someone moved the due date meanwhile', async () => {
    const { server, robin, home } = smallWorld()
    const id = server.addReminder(home, 'Bins', { due_date: '2026-11-06', repeat: 'FREQ=WEEKLY;BYDAY=FR' })
    const engine = client(server, robin)
    await engine.start()
    server.change('reminder', id, { due_date: '2026-11-20' })
    engine.toggle(id)
    await engine.flush()
    expect(engine.notices.at(-1)?.code).toBe('due_changed')
    expect(engine.view().reminder(id)?.due_date).toBe('2026-11-20')
    expect(engine.view().reminders.filter((r) => r.title === 'Bins')).toHaveLength(1)
  })
})

describe('files and order', () => {
  it('uploads after the reminder is confirmed, and the file comes back by its id', async () => {
    const { server, robin, home } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    const id = uuid4()
    engine.put('reminder', id, { list_id: home, title: 'With a file', position: 'a1' })
    const attachment = await engine.attach(id, new Blob(['hello'], { type: 'text/plain' }), 'note.txt')
    await engine.flush()
    const paths = server.requests.map((r) => r.path).filter((p) => p.includes('/batch') || p.includes('/files'))
    expect(paths).toEqual(['/api/app/1/batch', '/api/app/1/files'])
    expect(server.data('attachment', attachment)).toMatchObject({ name: 'note.txt', size: 5, reminder_id: id })
    expect(engine.view().attachmentsOf(id)[0].hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the own order of spaces', async () => {
    const { server, robin, family } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    engine.setSpacePosition(family, 'a0')
    await engine.flush()
    expect(engine.view().spaces[0].id).toBe(family)
    expect(server.member(family, robin)?.data.position).toBe('a0')
  })

  it('sends nothing twice: an op the server already answered is answered the same', async () => {
    const { server, robin, home } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    const id = uuid4()
    const op = { op_id: uuid4(), type: 'put' as const, kind: 'reminder' as const, id, fields: { list_id: home, title: 'Once', position: 'a1' }, clock: { place: 1, title: 1 } }
    const first = server.apply(robin, op)
    const again = server.apply(robin, op)
    expect(again).toBe(first)
  })
})

describe('hiding a space (space_pref, contract 0.3)', () => {
  it('reaches the other browser of the same person, and showing it again too', async () => {
    const { server, robin, family } = smallWorld()
    const laptop = client(server, robin)
    const phone = client(server, robin)
    await laptop.start()
    await phone.start()
    laptop.put('space_pref', family, { hidden: true })
    expect(laptop.view().isHidden(family)).toBe(true)
    await quiet(laptop, phone)
    expect(server.rows.get(`space_pref:${robin}:${family}`)?.data.hidden).toBe(true)
    expect(phone.view().hiddenSpaces.map((s) => s.name)).toEqual(['Family'])
    phone.put('space_pref', family, { hidden: false })
    await quiet(laptop, phone)
    expect(laptop.view().hiddenSpaces).toEqual([])
    expect(laptop.view().shownSpaces.map((s) => s.name)).toEqual(['Private', 'Family'])
  })

  it('is one person’s own: the others in the space still see it', async () => {
    const { server, robin, alex, family } = smallWorld()
    const mine = client(server, robin)
    const theirs = client(server, alex)
    await mine.start()
    await theirs.start()
    mine.put('space_pref', family, { hidden: true })
    await quiet(mine, theirs)
    expect(theirs.view().isHidden(family)).toBe(false)
    expect(theirs.view().shownSpaces.map((s) => s.name)).toContain('Family')
  })

  it('goes with the space when the space goes', async () => {
    const { server, alex, family } = smallWorld()
    const engine = client(server, alex)
    await engine.start()
    engine.put('space_pref', family, { hidden: true })
    await quiet(engine)
    // Only the list of spaces tells it (no entry per thing): the setting goes with the space all the same.
    server.rows.delete(`member:${family}:${alex}`)
    server.addReminder(server.addList(family, 'Later'), 'Bump')
    await engine.pull()
    expect([...engine.records.keys()].some((key) => key.startsWith('space_pref:'))).toBe(false)
  })

  it('leaves a kind it does not know out of the view (a newer server may send one)', async () => {
    const { server, robin, home } = smallWorld()
    const engine = client(server, robin)
    await engine.start()
    const before = engine.view()
    engine.receive({ kind: 'future_thing' as never, id: uuid4(), cursor: 999, deleted: false, data: { id: 'x', hidden: true }, clock: {} })
    const after = engine.view()
    expect(after.spaces).toEqual(before.spaces)
    expect(after.live.filter((r) => r.list_id === home)).toEqual(before.live.filter((r) => r.list_id === home))
  })
})
