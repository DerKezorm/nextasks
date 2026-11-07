// The shared test sets of server, web and app (`nextasks-ios/docs/pruefsaetze`, copied unchanged into
// `src/test/pruefsaetze`): repetition, the tie rule, quick entry and order keys must come out exactly as the Python
// reference computes them. Own filters too: what each finds, in which order, and the number in the sidebar.
import { describe, expect, it } from 'vitest'

import ausblenden from '../test/pruefsaetze/ausblenden.json'
import filter from '../test/pruefsaetze/filter.json'
import gleichstand from '../test/pruefsaetze/gleichstand.json'
import klartext from '../test/pruefsaetze/notiz-klartext.json'
import position from '../test/pruefsaetze/position.json'
import schnelleingabe from '../test/pruefsaetze/schnelleingabe.json'
import wiederholung from '../test/pruefsaetze/wiederholung.json'
import { plainNotes } from '../lib/notes'
import { applyComplete, copyId, type Stored } from './complete'
import { fresh } from './fields'
import { canonical } from './jcs'
import { outcome } from './merge'
import { isValidKey, keyBetween, keysBetween } from './position'
import { parseQuick } from './quick'
import { nextDue, parseRule, step } from './repeat'
import { filterCount, filterItems, TILES, tileItems } from './tiles'
import type { Data, Kind } from './types'
import { buildView, type Rec } from './view'

type From = 'due' | 'completion'

describe('wiederholung.json', () => {
  it.each(wiederholung.next_due.map((c) => [`${c.rule} ${c.repeat_from} ${c.due_date} on ${c.on}`, c] as const))('next due: %s', (_, c) => {
    expect(nextDue(c.rule, c.repeat_from as From, c.due_date, c.on)).toBe(c.expect)
  })

  it.each(wiederholung.count.map((c) => [`${c.rule} ${c.due_date}`, c] as const))('after completing: %s', (_, c) => {
    const result = step(c.rule, c.repeat_from as From, c.due_date, c.on)
    expect(result.ended ? null : { repeat: result.repeat, due_date: result.due }).toEqual(c.expect)
  })

  it.each(wiederholung.copy_id.map((c) => [c.occurrence, c] as const))('copy id: %s', (_, c) => {
    expect(copyId(c.original_id, c.occurrence)).toBe(c.expect)
  })

  it.each(wiederholung.invalid.map((c) => [`"${c.rule}" ${c.repeat_from}`, c] as const))('refuses %s', (_, c) => {
    expect(parseRule(c.rule, c.repeat_from as From)).toBeNull()
  })

  it.each([...wiederholung.valid, ...wiederholung.next_due, ...wiederholung.count].map((c) => [`${c.rule} ${c.repeat_from}`, c] as const))('takes %s', (_, c) => {
    expect(parseRule(c.rule, c.repeat_from as From)).not.toBeNull()
  })

  it('completes with a copy, then answers already_done for the same occurrence (Festlegung 8)', () => {
    const id = '6f1c2a9e-4b7d-4c1e-9a3f-2d5e8b7c1a40'
    const store = new Map<string, Stored>([[id, { data: { id, title: 'Bins', due_date: '2026-11-06', due_time: '07:00', repeat: 'FREQ=WEEKLY;BYDAY=FR', repeat_from: 'due', completed_at: null, parent_id: null }, clock: { due: 1, completion: 1, title: 1 } }]])
    const world = { reminder: (x: string) => store.get(x), children: () => [], save: (x: string, r: Stored) => void store.set(x, r) }
    const first = applyComplete(world, id, '2026-11-06', '2026-11-06T08:00:00.000Z', '2026-11-06', 3)
    expect(first.code).toBe('ok')
    expect(first.copy_id).toBe('9693ecac-45d8-547d-b629-9e63a6aa3fa0')
    expect(store.get(id)!.data.due_date).toBe('2026-11-13')
    const copy = store.get(first.copy_id!)!
    expect(copy.data).toMatchObject({ repeat: null, due_date: '2026-11-06', completed_by: 3, completed_at: '2026-11-06T08:00:00.000Z' })
    expect(Object.values(copy.clock).every((t) => t === Date.parse('2026-11-06T08:00:00.000Z'))).toBe(true)
    expect(applyComplete(world, id, '2026-11-06', '2026-11-06T08:01:00.000Z', '2026-11-06', 3).code).toBe('already_done')
    expect(applyComplete(world, id, '2026-11-20', '2026-11-06T08:01:00.000Z', '2026-11-06', 3).code).toBe('due_changed')
  })
})

describe('gleichstand.json', () => {
  it.each(gleichstand.canonical.map((c, i) => [i, c] as const))('canonical #%s', (_, c) => {
    expect(canonical(c.value)).toBe(c.expect)
  })

  it.each(gleichstand.merge.map((c, i) => [`#${i} ${c.field}`, c] as const))('merge %s', (_, c) => {
    expect(outcome(c.stored_value, c.stored_clock, c.incoming_value, c.incoming_clock)).toBe(c.expect)
  })
})

describe('schnelleingabe.json', () => {
  it.each(schnelleingabe.cases.map((c) => [`${c.lang} "${c.input}"`, c] as const))('%s', (_, c) => {
    const [today, now] = c.now.split('T')
    expect(parseQuick(c.input, { language: c.lang, today, now })).toEqual({
      title: c.expect.title,
      due_date: c.expect.due_date,
      due_time: c.expect.due_time,
      tags: c.expect.tags,
      priority: c.expect.priority,
    })
  })
})

describe('position.json', () => {
  it.each(position.between.map((c) => [`${c.a} | ${c.b}`, c] as const))('between %s', (_, c) => {
    expect(keyBetween(c.a, c.b)).toBe(c.key)
  })

  it('appends and prepends 30', () => {
    const after: string[] = []
    const before: string[] = []
    for (let i = 0; i < 30; i++) {
      after.push(keyBetween(after.at(-1) ?? null, null))
      before.push(keyBetween(null, before.at(-1) ?? null))
    }
    expect(after).toEqual(position.append_30)
    expect(before).toEqual(position.prepend_30)
  })

  it('bisects towards the lower end and spreads n keys', () => {
    const keys: string[] = []
    let upper = position.bisect_lower_20_from.b
    for (let i = 0; i < 20; i++) {
      upper = keyBetween(position.bisect_lower_20_from.a, upper)
      keys.push(upper)
    }
    expect(keys).toEqual(position.bisect_lower_20_from.keys)
    const n = position.n_keys_between
    expect(keysBetween(n.a, n.b, n.n)).toEqual(n.keys)
  })

  it.each(position.must_fail.map((c) => [`${c.a} | ${c.b}`, c] as const))('fails between %s', (_, c) => {
    expect(() => keyBetween(c.a, c.b)).toThrow()
  })

  it.each(position.invalid_keys.map((c) => [JSON.stringify(c.key), c] as const))('a key from the network %s is refused', (_, c) => {
    expect(isValidKey(c.key)).toBe(false)
  })

  it('takes every key the library makes', () => {
    for (const key of [...position.append_30, ...position.prepend_30, ...position.bisect_lower_20_from.keys]) expect(isValidKey(key)).toBe(true)
  })
})

describe('notiz-klartext.json', () => {
  it.each(klartext.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(plainNotes(c.input, (c as { lang?: string }).lang ?? 'de')).toBe(c.expect)
  })

  it('has enough cases', () => {
    expect(klartext.cases.length).toBeGreaterThanOrEqual(40)
  })
})

describe('ausblenden.json', () => {
  const ids = new Map<string, string>()
  // The set names things in words; the view takes any id, but the records get real ones as everywhere.
  const id = (name: string) => ids.get(name) ?? (ids.set(name, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`), ids.get(name)!)
  const rec = (kind: Kind, name: string, data: Data): Rec => {
    const made = fresh(kind, id(name))
    return { kind, id: id(name), data: { ...made.data, ...data, id: id(name) }, clock: made.clock }
  }
  const world = ausblenden.world
  const view = (hidden: string[]) => {
    const me = ausblenden.me
    const recs: Rec[] = [
      ...world.spaces.flatMap((s) => [
        rec('space', s.id, { name: s.name, private: s.private, role: 'manager' }),
        rec('member', `${s.id}:me`, { space_id: id(s.id), account_id: me, role: 'manager', position: null }),
      ]),
      ...world.lists.map((l) => rec('list', l.id, { space_id: id(l.space_id), name: l.id, position: l.position })),
      ...world.reminders.map((r) => {
        const extra = r as { due_date?: string; flagged?: boolean; assignees?: number[]; completed?: boolean; deleted?: boolean }
        return rec('reminder', r.id, {
          list_id: id(r.list_id),
          title: r.id,
          position: 'a0',
          due_date: extra.due_date ?? null,
          flagged: !!extra.flagged,
          assignees: extra.assignees ?? [],
          completed_at: extra.completed ? '2026-11-05T10:00:00.000Z' : null,
          deleted_at: extra.deleted ? '2026-11-05T10:00:00.000Z' : null,
        })
      }),
      // A space setting has the id of its space.
      ...hidden.map((space) => rec('space_pref', space, { hidden: true })),
    ]
    return buildView(recs, new Map(), me)
  }

  it.each(ausblenden.collections.map((c) => [c.hidden.join(',') || 'none', c] as const))('collections with %s hidden', (_, c) => {
    const v = view(c.hidden)
    const got = Object.fromEntries(TILES.map((tile) => [tile, tileItems(v, tile, ausblenden.today).length]))
    expect(got).toEqual(c.expect)
  })

  it.each(ausblenden.default_list.map((c) => [c.hidden.join(',') || 'none', c] as const))('default list with %s hidden', (_, c) => {
    const got = view(c.hidden).defaultList?.id ?? null
    expect(got).toBe(c.expect === null ? null : id(c.expect))
  })
})

describe('filter.json', () => {
  // The set names things in words; the view takes them as ids as they are, the conditions name the same words.
  const rec = (kind: Kind, id: string, data: Data): Rec => {
    const made = fresh(kind, id)
    return { kind, id, data: { ...made.data, ...data, id }, clock: made.clock }
  }
  const world = filter.world
  const view = (hidden: string[]) =>
    buildView(
      [
        ...world.spaces.map((s) => rec('space', s.id, { name: s.id, private: s.id === 's-privat', role: 'manager' })),
        ...world.lists.map((l) => rec('list', l.id, { space_id: l.space_id, name: l.id, position: 'a0' })),
        ...world.reminders.map((r) => {
          const extra = r as { parent_id?: string; due_date?: string; due_time?: string; flagged?: boolean; priority?: number; tags?: string[]; assignees?: number[]; completed_at?: string; deleted?: boolean }
          return rec('reminder', r.id, {
            list_id: r.list_id,
            parent_id: extra.parent_id ?? null,
            title: r.id,
            position: r.position,
            due_date: extra.due_date ?? null,
            due_time: extra.due_time ?? null,
            flagged: !!extra.flagged,
            priority: extra.priority ?? 0,
            tags: extra.tags ?? [],
            assignees: extra.assignees ?? [],
            completed_at: extra.completed_at ?? null,
            deleted_at: extra.deleted ? '2026-11-05T10:00:00.000Z' : null,
          })
        }),
        ...hidden.map((space) => rec('space_pref', space, { hidden: true })),
      ],
      new Map(),
      filter.me,
    )
  // Completions count by their day in a fixed zone (minutes from UTC), so that the set needs no time zone database.
  const dayIn = (zone: number) => (moment: string) => new Date(Date.parse(moment) + zone * 60_000).toISOString().slice(0, 10)

  it.each(filter.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const zone = (c as { zone?: number }).zone ?? filter.zone
    const v = view(c.hidden)
    expect(filterItems(v, c.rules, filter.today, dayIn(zone)).map((r) => r.id)).toEqual(c.expect)
    // The number only counts open ones, so the zone of completions does not matter for it.
    expect(filterCount(v, c.rules, filter.today)).toBe(c.count)
  })

  it('has enough cases', () => {
    expect(filter.cases.length).toBeGreaterThanOrEqual(30)
  })
})
