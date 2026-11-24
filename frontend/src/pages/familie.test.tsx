// Shopping with suggestions and sorting by section, templates, copying a list, all open again, "Someday" and the
// look through ("Rückschau").
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { forgetPrefs } from '../lib/devicePref'
import { localDay } from '../lib/due'
import { matching, placeFor, plainTitle, quantityOf, titleKey, type Suggestion } from '../lib/shop'
import { nextWeekday } from '../lib/templates'
import { addDays, weekdayOf } from '../sync/repeat'
import type { Reminder, Section } from '../sync/types'
import { FakeServer, smallWorld } from '../test/fakeServer'
import { button, click, mount, row, settle, titles, type, unmount, where } from '../test/harness'

afterEach(async () => {
  await unmount()
  forgetPrefs()
})

const today = localDay()

function reminders(server: FakeServer, title: string) {
  return [...server.rows.values()].filter((r) => r.kind === 'reminder' && r.data.title === title)
}

function suggestion(title: string, extra: Partial<Suggestion> = {}): Suggestion {
  return { title, key: titleKey(title), count: 4, last: new Date().toISOString(), last_days_ago: 2, interval_days: 7, expected: addDays(today, 5), section_id: null, section_name: null, ...extra }
}

const notice = () => document.querySelector('[data-testid="notice"]')

describe('titles as the server compares them', () => {
  it('leave out a count at the start and fold case and ß', () => {
    expect(titleKey('2 Gurken')).toBe('gurken')
    expect(titleKey('2x  Gurken')).toBe('gurken')
    expect(titleKey('1,5 l Milch')).toBe('milch')
    expect(titleKey('500 g Mehl')).toBe('mehl')
    expect(titleKey('Straße')).toBe('strasse')
    expect(titleKey('7')).toBe('7')
    expect(plainTitle('3 Äpfel')).toBe('Äpfel')
    expect(quantityOf('2 Gurken')).toBe('2 ')
    expect(quantityOf('Gurken')).toBe('')
  })

  it('find a section by what is open now, then by what was done last, then by the server', () => {
    const sections = [{ id: 's1', list_id: 'l', name: 'Chilled', position: 'a0' }, { id: 's2', list_id: 'l', name: 'Fruit', position: 'a1' }] as Section[]
    const r = (title: string, section_id: string | null, completed_at: string | null = null) => ({ id: title + section_id, list_id: 'l', parent_id: null, title, section_id, completed_at }) as Reminder
    expect(placeFor('2 Milk', 'l', [r('Milk', 's1')], sections)?.id).toBe('s1')
    expect(placeFor('Milk', 'l', [r('milk', 's2', '2026-11-01T10:00:00Z'), r('Milk', 's1', '2026-11-20T10:00:00Z')], sections)?.id).toBe('s1')
    expect(placeFor('Apples', 'l', [], sections, { apples: 's2' })?.id).toBe('s2')
    expect(placeFor('Apples', 'l', [], sections, { apples: 'gone' })).toBeNull()
    expect(placeFor('Bread', 'l', [], sections)).toBeNull()
  })

  it('offer what starts with the typed letters first', () => {
    const all = [suggestion('Oat milk'), suggestion('Milk'), suggestion('Mint')]
    expect(matching(all, 'mi').map((s) => s.title)).toEqual(['Milk', 'Mint', 'Oat milk'])
    expect(matching(all, 'm')).toEqual([])
    expect(matching(all, 'milk').map((s) => s.title)).toEqual(['Oat milk'])
  })
})

function shop() {
  const w = smallWorld()
  const { server, family, robin } = w
  const groceries = server.addList(family, 'Groceries', { color: 'green', icon: 'cart' })
  const chilled = server.addSection(groceries, 'Chilled', 'a0')
  const fruit = server.addSection(groceries, 'Fruit and veg', 'a1')
  server.addReminder(groceries, 'Bananas', { section_id: fruit })
  server.addReminder(groceries, 'Butter', { section_id: chilled, completed_at: new Date().toISOString(), completed_by: robin })
  server.suggestions.set(groceries, {
    list_id: groceries,
    suggestions: [suggestion('Milk', { section_id: chilled, section_name: 'Chilled' }), suggestion('Eggs', { interval_days: 10, expected: addDays(today, -2), last_days_ago: 12 }), suggestion('Bananas')],
    sections: [],
    placement: { milk: chilled, cucumbers: fruit },
  })
  return { ...w, groceries, chilled, fruit }
}

describe('a list with suggestions', () => {
  it('offers what is often bought and not open, and adds it into its section with a notice', async () => {
    const { server, groceries, chilled } = shop()
    const page = await mount(server, `/lists/${groceries}`)
    const often = page.querySelector('[data-testid="often"]')!
    expect(often.textContent).toContain('Often bought:')
    const items = [...often.querySelectorAll('[data-testid="often-item"]')].map((b) => b.textContent)
    // Bananas are open in the list: not offered.
    expect(items).toEqual(['Milkevery week', 'Eggs12 days ago'])
    await click(often.querySelector('[data-testid="often-item"]'))
    const [milk] = reminders(server, 'Milk')
    expect(milk.data.section_id).toBe(chilled)
    expect(notice()?.textContent).toContain('Sorted into “Chilled”')
    await click(notice()!.querySelector('[data-testid="notice-undo"]'))
    expect(reminders(server, 'Milk')[0].data.section_id).toBeNull()
  })

  it('sorts a typed task by its title, counts included, and offers suggestions while typing', async () => {
    const { server, groceries, fruit } = shop()
    const page = await mount(server, `/lists/${groceries}`)
    const field = page.querySelector<HTMLInputElement>('[data-testid="quick-entry"]')!
    await type(field, '2 mi')
    const offers = page.querySelector('[data-testid="quick-offers"]')!
    expect(offers.textContent).toContain('2 Milk')
    await click(offers.querySelector('[role="option"]'))
    expect(reminders(server, '2 Milk')).toHaveLength(1)
    await type(field, '2 Cucumbers')
    await act(async () => field.form!.requestSubmit())
    await settle()
    expect(reminders(server, '2 Cucumbers')[0].data.section_id).toBe(fruit)
    expect(notice()?.textContent).toContain('Sorted into “Fruit and veg”')
    await type(field, 'Batteries')
    await act(async () => field.form!.requestSubmit())
    await settle()
    expect(reminders(server, 'Batteries')[0].data.section_id).toBeNull()
  })

  it('shows nothing of it when the server has no suggestions', async () => {
    const { server, home } = smallWorld()
    const page = await mount(server, `/lists/${home}`)
    expect(page.querySelector('[data-testid="often"]')).toBeNull()
  })

  it('shows how many are done in a bar when the done ones are shown', async () => {
    const { server, groceries, robin } = shop()
    const page = await mount(server, `/lists/${groceries}`)
    expect(page.querySelector('[data-testid="list-progress"]')).toBeNull()
    server.addPref('list_pref', groceries, robin, { show_completed: true, notify_changes: false })
    await unmount()
    const again = await mount(server, `/lists/${groceries}`)
    expect(again.querySelector('[data-testid="list-progress"]')?.textContent).toContain('1 of 2 done')
  })
})

describe('templates, copies and all open again', () => {
  it('makes a packing list with its sections and tasks', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/today')
    await click(button(page, 'New list'))
    await click(page.querySelector('[data-testid="template-packing"]'))
    expect(page.querySelector<HTMLInputElement>('input[maxlength="80"]')!.value).toBe('Packing list')
    await click(button(page, 'Create list'))
    const list = [...server.rows.values()].find((r) => r.kind === 'list' && r.data.name === 'Packing list')!
    expect(list.data.icon).toBe('suitcase')
    const sections = [...server.rows.values()].filter((r) => r.kind === 'section' && r.data.list_id === list.id).sort((a, b) => String(a.data.position).localeCompare(String(b.data.position)))
    expect(sections.map((s) => s.data.name)).toEqual(['Clothes', 'Bathroom', 'Tech', 'Papers'])
    expect(reminders(server, 'Toothbrush')[0].data.section_id).toBe(sections[1].id)
    expect(titles(page)).toContain('Socks')
  })

  it('makes a weekly clean whose tasks come back every week', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/today')
    await click(button(page, 'New list'))
    await click(page.querySelector('[data-testid="template-cleaning"]'))
    await click(button(page, 'Create list'))
    const [hob] = reminders(server, 'Clean the hob')
    expect(hob.data.repeat).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(weekdayOf(hob.data.due_date as string)).toBe(0)
    expect(hob.data.due_date).toBe(nextWeekday(today, 0))
  })

  it('copies a list with its sections, all open, without dates unless asked', async () => {
    const { server, groceries, chilled, privateList } = shop()
    server.addReminder(groceries, 'Flowers', { due_date: addDays(today, 2) })
    const privateSpace = server.data('list', privateList)!.space_id as string
    const page = await mount(server, `/lists/${groceries}`)
    await click(button(page, 'More about the list'))
    await click(button(page, 'Copy list'))
    expect(page.querySelector<HTMLInputElement>('[data-testid="copy-list"] input[maxlength="80"]')!.value).toBe('Groceries (copy)')
    await act(async () => {
      const select = page.querySelector<HTMLSelectElement>('[data-testid="copy-space"]')!
      select.value = privateSpace
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(page.querySelector('[data-testid="copy-go"]'))
    const copy = [...server.rows.values()].find((r) => r.kind === 'list' && r.data.name === 'Groceries (copy)')!
    expect(copy.data.space_id).toBe(privateSpace)
    expect(where.path).toBe(`/lists/${copy.id}`)
    const butter = reminders(server, 'Butter').find((r) => r.data.list_id === copy.id)!
    expect(butter.data.completed_at ?? null).toBeNull()
    const newChilled = server.data('section', butter.data.section_id as string)!
    expect(newChilled.name).toBe('Chilled')
    expect(butter.data.section_id).not.toBe(chilled)
    expect(reminders(server, 'Flowers').find((r) => r.data.list_id === copy.id)!.data.due_date ?? null).toBeNull()
  })

  it('opens every done task again after asking, and "Undo" ticks them off again', async () => {
    const { server, groceries } = shop()
    const page = await mount(server, `/lists/${groceries}`)
    await click(button(page, 'More about the list'))
    await click(button(page, 'All open again'))
    expect(document.querySelector('[data-testid="confirm-dialog"]')?.textContent).toContain('The done task becomes open again')
    await click(document.querySelector('[data-testid="confirm-go"]'))
    expect(reminders(server, 'Butter')[0].data.completed_at).toBeNull()
    expect(notice()?.textContent).toContain('One task is open again.')
    await click(notice()!.querySelector('[data-testid="notice-undo"]'))
    expect(reminders(server, 'Butter')[0].data.completed_at).not.toBeNull()
  })
})

describe('Someday', () => {
  it('lists the open tasks without a date by list, and its number stands in the sidebar after "All"', async () => {
    const { server, home, privateList } = smallWorld()
    server.addReminder(home, 'Paint the shed')
    server.addReminder(home, 'Dentist', { due_date: today })
    server.addReminder(privateList, 'Learn Spanish')
    const page = await mount(server, '/someday')
    expect(titles(page)).toEqual(['Learn Spanish', 'Paint the shed'])
    const tiles = [...page.querySelectorAll('aside nav a')].map((a) => a.getAttribute('data-testid'))
    expect(tiles.indexOf('tile-someday')).toBe(tiles.indexOf('tile-all') + 1)
    expect(page.querySelector('[data-testid="tile-count-someday"]')?.textContent).toBe('2')
  })

  it('takes a date away from the menu of a row, with "Undo"', async () => {
    const { server, home } = smallWorld()
    server.addReminder(home, 'Dentist', { due_date: today, repeat: 'FREQ=DAILY', repeat_from: 'due' })
    const page = await mount(server, `/lists/${home}`)
    const dentist = row(page, 'Dentist')!
    await click(dentist.querySelector('button[aria-label="Date"]'))
    await click(page.querySelector('[data-testid="row-someday"]'))
    expect(reminders(server, 'Dentist')[0].data.due_date).toBeNull()
    expect(notice()?.textContent).toContain('“Dentist” now waits under Someday.')
    await click(notice()!.querySelector('[data-testid="notice-undo"]'))
    expect(reminders(server, 'Dentist')[0].data.due_date).toBe(today)
    expect(reminders(server, 'Dentist')[0].data.repeat).toBe('FREQ=DAILY')
  })

  it('hides on this device only, from the settings', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/settings/appearance')
    await click(page.querySelector('[data-testid="pref-tile-someday-eye"]'))
    expect(page.querySelector('[data-testid="tile-someday"]')).toBeNull()
    expect([...server.rows.values()].some((r) => r.kind === 'tile_pref')).toBe(false)
  })
})

describe('the look through', () => {
  function sweepWorld() {
    const w = smallWorld()
    const { server, home } = w
    const attic = server.addReminder(home, 'Clear the attic')
    const tax = server.addReminder(home, 'Tax return', { due_date: addDays(today, -3) })
    const bike = server.addReminder(home, 'Fix the bike light')
    const bins = server.addReminder(home, 'Bins', { due_date: addDays(today, -1), repeat: 'FREQ=WEEKLY', repeat_from: 'due' })
    const brief = { id: home, name: 'Home', color: 'orange', icon: 'house', space_id: w.family, deleted: false }
    const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, list: brief, age_days: 47, unchanged_days: 30, overdue_days: null, reasons: ['unchanged'], ...extra })
    server.sweep = [task(attic, 'Clear the attic'), task(tax, 'Tax return', { overdue_days: 3 }), task(bike, 'Fix the bike light'), task(bins, 'Bins')]
    return { ...w, attic, tax, bike, bins }
  }
  const key = (k: string) => act(async () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
  const card = () => document.querySelector('[data-testid="sweep-card"]')

  it('leads there from "All" with the number of tasks waiting', async () => {
    const { server } = sweepWorld()
    const page = await mount(server, '/all')
    const link = page.querySelector('[data-testid="sweep-button"]')!
    expect(link.getAttribute('aria-label')).toBe('Look back: 4 tasks')
    await click(link)
    expect(where.path).toBe('/sweep')
  })

  it('goes through one at a time by keys, and sums up at the end', async () => {
    const { server, attic, tax, bike } = sweepWorld()
    const page = await mount(server, '/sweep')
    expect(card()?.textContent).toContain('Clear the attic')
    expect(card()?.textContent).toContain('open for 47 days')
    expect(page.querySelector('[data-testid="page-count"]')?.textContent).toBe('1 of 4')
    await key('k')
    await settle()
    expect(server.kept.has(attic)).toBe(true)
    expect(card()?.textContent).toContain('Tax return')
    // N is "new task" elsewhere; here it moves the task to next week.
    await key('n')
    expect(server.data('reminder', tax)!.due_date).toBe(addDays(today, 7))
    expect(document.querySelector('[data-testid="detail"]')).toBeNull()
    await key('s')
    expect(server.data('reminder', bike)!.due_date ?? null).toBeNull()
    // A repeating task keeps its date: "Someday" is off for it.
    expect(page.querySelector<HTMLButtonElement>('[data-testid="sweep-parked"]')!.disabled).toBe(true)
    await key('Delete')
    expect(reminders(server, 'Bins')[0].data.deleted_at).not.toBeNull()
    const summary = page.querySelector('[data-testid="sweep-summary"]')!
    expect(summary.textContent).toContain('4 tasks looked at.')
    expect(summary.textContent).toContain('one kept · one to next week · one to Someday · one dropped')
  })

  it('passes over a task done meanwhile and says when nothing is left', async () => {
    const { server, attic, tax, bike, bins } = sweepWorld()
    for (const id of [tax, bike, bins]) server.change('reminder', id, { completed_at: new Date().toISOString() })
    const page = await mount(server, '/sweep')
    expect(page.querySelector('[data-testid="page-count"]')?.textContent).toBe('1 of 4')
    await click(page.querySelector('[data-testid="sweep-kept"]'))
    expect(server.kept.has(attic)).toBe(true)
    expect(page.querySelector('[data-testid="sweep-summary"]')?.textContent).toContain('One task looked at.')
  })
})
