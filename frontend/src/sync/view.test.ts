// The reading rules, the trash and the tiles, on hand-made records (data model, "Lesen", "Papierkorb", "Kacheln").
import { describe, expect, it } from 'vitest'

import { search } from '../lib/actions'
import { fresh } from './fields'
import { byDue, tileCount, tileItems } from './tiles'
import type { Data, Kind, Reminder } from './types'
import { buildView, type Rec } from './view'

const SPACE = '00000000-0000-4000-8000-000000000001'
const LIST = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'
const SECTION = '00000000-0000-4000-8000-000000000004'
let n = 100

function rec(kind: Kind, data: Data, id = `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`): Rec {
  const made = fresh(kind, id)
  return { kind, id, data: { ...made.data, ...data, id }, clock: made.clock }
}

function base(): Rec[] {
  return [
    rec('space', { name: 'Home', private: true, role: 'manager' }, SPACE),
    rec('member', { space_id: SPACE, account_id: 1, role: 'manager', position: null }, `${SPACE}:1`),
    rec('list', { space_id: SPACE, name: 'A', position: 'a0' }, LIST),
    rec('list', { space_id: SPACE, name: 'B', position: 'a1' }, OTHER),
    rec('section', { list_id: LIST, name: 'S', position: 'a0' }, SECTION),
  ]
}

function view(extra: Rec[]) {
  return buildView([...base(), ...extra], new Map(), 1)
}

describe('reading rules', () => {
  it('drop a parent that has a parent, is missing, or lies in another list', () => {
    const top = rec('reminder', { list_id: LIST, title: 'top', position: 'a0' })
    const sub = rec('reminder', { list_id: LIST, title: 'sub', parent_id: top.id, position: 'a0' })
    const subsub = rec('reminder', { list_id: LIST, title: 'subsub', parent_id: sub.id, position: 'a0' })
    const lost = rec('reminder', { list_id: LIST, title: 'lost', parent_id: '00000000-0000-4000-8000-00000000ffff', position: 'a1' })
    const elsewhere = rec('reminder', { list_id: OTHER, title: 'elsewhere', parent_id: top.id, position: 'a0' })
    const v = view([top, sub, subsub, lost, elsewhere])
    expect(v.reminder(sub.id)!.parent_id).toBe(top.id)
    expect(v.reminder(subsub.id)!.parent_id).toBeNull()
    expect(v.reminder(lost.id)!.parent_id).toBeNull()
    expect(v.reminder(elsewhere.id)!.parent_id).toBeNull()
  })

  it('put a subtask without section, and a section of another list or a missing one to none', () => {
    const top = rec('reminder', { list_id: LIST, title: 'top', position: 'a0', section_id: SECTION })
    const sub = rec('reminder', { list_id: LIST, title: 'sub', parent_id: top.id, section_id: SECTION, position: 'a0' })
    const wrong = rec('reminder', { list_id: OTHER, title: 'wrong', section_id: SECTION, position: 'a0' })
    const missing = rec('reminder', { list_id: LIST, title: 'missing', section_id: '00000000-0000-4000-8000-00000000eeee', position: 'a1' })
    const v = view([top, sub, wrong, missing])
    expect(v.reminder(top.id)!.section_id).toBe(SECTION)
    expect(v.reminder(sub.id)!.section_id).toBeNull()
    expect(v.reminder(wrong.id)!.section_id).toBeNull()
    expect(v.reminder(missing.id)!.section_id).toBeNull()
  })

  it('read time and repetition without a date as none', () => {
    const r = rec('reminder', { list_id: LIST, title: 'r', position: 'a0', due_time: '09:00', repeat: 'FREQ=DAILY' })
    expect(view([r]).reminder(r.id)).toMatchObject({ due_time: null, repeat: null })
  })
})

describe('the trash', () => {
  it('holds what is deleted itself or below something deleted, and shows only the top of it', () => {
    const top = rec('reminder', { list_id: OTHER, title: 'top', position: 'a0', deleted_at: '2026-11-01T00:00:00.000Z' })
    const sub = rec('reminder', { list_id: OTHER, title: 'sub', parent_id: top.id, position: 'a0' })
    const gone = rec('list', { space_id: SPACE, name: 'Gone', position: 'a2', deleted_at: '2026-11-01T00:00:00.000Z' })
    const inGone = rec('reminder', { list_id: gone.id, title: 'in gone', position: 'a0', deleted_at: '2026-11-01T00:00:00.000Z' })
    const v = view([top, sub, gone, inGone])
    expect(v.inTrash(v.reminder(sub.id)!)).toBe(true)
    expect(v.live.map((r) => r.title)).toEqual([])
    expect(v.trash.reminders.map((r) => r.title)).toEqual(['top'])
    expect(v.trash.lists.map((l) => l.name)).toEqual(['Gone'])
  })
})

describe('the tiles', () => {
  const today = '2026-11-06'
  const make = (title: string, data: Data) => rec('reminder', { list_id: LIST, title, position: 'a' + (n % 10), ...data })

  it('count open reminders outside the trash, subtasks included, Done without a number', () => {
    const parent = make('parent', { due_date: today })
    const v = view([
      parent,
      make('child', { parent_id: parent.id, due_date: '2026-11-01' }),
      make('later', { due_date: '2026-11-20', flagged: true }),
      make('mine', { assignees: [1] }),
      make('done', { due_date: today, completed_at: '2026-11-06T08:00:00.000Z' }),
      make('trashed', { due_date: today, deleted_at: '2026-11-06T08:00:00.000Z' }),
    ])
    expect(tileCount(v, 'today', today)).toBe(2)
    expect(tileCount(v, 'scheduled', today)).toBe(3)
    expect(tileCount(v, 'all', today)).toBe(4)
    expect(tileCount(v, 'flagged', today)).toBe(1)
    expect(tileCount(v, 'assigned', today)).toBe(1)
    expect(tileCount(v, 'done', today)).toBeNull()
    expect(tileItems(v, 'done', today).map((r) => r.title)).toEqual(['done'])
  })

  it('sort by due date, without a time before with one, then the time and the position', () => {
    const list = [
      { id: 'b', position: 'a0', due_date: today, due_time: '10:00' },
      { id: 'a', position: 'a1', due_date: today, due_time: null },
      { id: 'c', position: 'a0', due_date: '2026-11-05', due_time: '23:00' },
      { id: 'd', position: 'a0', due_date: null, due_time: null },
      { id: 'e', position: 'a2', due_date: today, due_time: '09:00' },
    ] as Reminder[]
    expect([...list].sort(byDue).map((r) => r.id)).toEqual(['c', 'a', 'e', 'b', 'd'])
  })

  it('put assigned reminders without a date last', () => {
    const v = view([make('no date', { assignees: [1] }), make('dated', { assignees: [1], due_date: '2026-12-01' })])
    expect(tileItems(v, 'assigned', today).map((r) => r.title)).toEqual(['dated', 'no date'])
  })
})

describe('hidden spaces (space_pref, contract 0.3)', () => {
  const FAMILY = '00000000-0000-4000-8000-0000000000f1'
  const SHOP = '00000000-0000-4000-8000-0000000000f2'

  function shared(hidden: { space?: boolean; family?: boolean } = {}): { recs: Rec[]; mine: Rec; theirs: Rec } {
    const today = '2026-11-06'
    const mine = rec('reminder', { list_id: LIST, title: 'mine', position: 'a0', due_date: today, flagged: true, assignees: [1] })
    const theirs = rec('reminder', { list_id: SHOP, title: 'theirs', position: 'a0', due_date: today, flagged: true, assignees: [1] })
    const doneThere = rec('reminder', { list_id: SHOP, title: 'done there', position: 'a1', completed_at: '2026-11-05T10:00:00.000Z' })
    const recs = [
      rec('space', { name: 'Family', private: false, role: 'member' }, FAMILY),
      rec('member', { space_id: FAMILY, account_id: 1, role: 'member', position: null }, `${FAMILY}:1`),
      rec('list', { space_id: FAMILY, name: 'Shop', position: 'a0' }, SHOP),
      mine,
      theirs,
      doneThere,
    ]
    if (hidden.family !== undefined) recs.push(rec('space_pref', { hidden: hidden.family }, FAMILY))
    if (hidden.space !== undefined) recs.push(rec('space_pref', { hidden: hidden.space }, SPACE))
    return { recs, mine, theirs }
  }

  it('leaves a hidden space out of the sidebar but keeps it for the order', () => {
    const v = view(shared({ family: true }).recs)
    expect(v.shownSpaces.map((s) => s.name)).toEqual(['Home'])
    expect(v.hiddenSpaces.map((s) => s.name)).toEqual(['Family'])
    expect(v.spaces.map((s) => s.name)).toEqual(['Home', 'Family'])
    expect(v.isHidden(FAMILY)).toBe(true)
  })

  it('does not count a hidden space in any collection, Done included', () => {
    const { recs, mine } = shared({ family: true })
    const v = view(recs)
    for (const tile of ['today', 'scheduled', 'all', 'flagged', 'assigned'] as const) {
      expect(tileItems(v, tile, '2026-11-06').map((r) => r.id)).toEqual([mine.id])
      expect(tileCount(v, tile, '2026-11-06')).toBe(1)
    }
    expect(tileItems(v, 'done', '2026-11-06')).toEqual([])
  })

  it('counts it again once shown again (hidden: false)', () => {
    const v = view(shared({ family: false }).recs)
    expect(v.hiddenSpaces).toEqual([])
    expect(tileCount(v, 'today', '2026-11-06')).toBe(2)
    expect(tileItems(v, 'done', '2026-11-06')).toHaveLength(1)
  })

  it('keeps the reminders of a hidden space readable (a link from a notification still opens them)', () => {
    const { recs, theirs } = shared({ family: true })
    const v = view(recs)
    expect(v.reminder(theirs.id)?.title).toBe('theirs')
    expect(v.live.some((r) => r.id === theirs.id)).toBe(true)
    expect(v.visible.some((r) => r.id === theirs.id)).toBe(false)
  })

  it('leaves a hidden space out of the search', () => {
    const { recs, mine } = shared({ family: true })
    expect(search(view(recs), 'mine', false).map((r) => r.id)).toEqual([mine.id])
    expect(search(view(recs), 'theirs', true)).toEqual([])
    expect(search(view(shared({ family: false }).recs), 'theirs', false)).toHaveLength(1)
  })

  it('never takes a list in a hidden space as the default for a new task', () => {
    expect(view(shared().recs).defaultList?.id).toBe(LIST)
    const privateHidden = view(shared({ space: true }).recs)
    expect(privateHidden.defaultList?.id).toBe(SHOP)
    expect(privateHidden.firstPrivateList?.id).toBe(LIST)
    expect(view(shared({ space: true, family: true }).recs).defaultList).toBeUndefined()
  })
})
