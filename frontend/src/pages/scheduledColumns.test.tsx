// "Scheduled" as day columns: switching and keeping the choice on the device, every day a column, "Overdue" first,
// dragging to another day (only the date changes, also for a repeating task), "+" on a day, the list on a phone.
import { afterEach, describe, expect, it } from 'vitest'

import { dueChange } from '../lib/actions'
import { columnsFor, dayColumns, DAY_GAP, DAY_MAX, DAY_MIN } from '../lib/dayColumns'
import { forgetPrefs, prefKey, setPref } from '../lib/devicePref'
import { localDay } from '../lib/due'
import { addDays, WEEKDAYS } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { FakeServer, smallWorld } from '../test/fakeServer'
import { click, drag, mount, row, submit, type, unmount } from '../test/harness'

const realMatchMedia = window.matchMedia

afterEach(async () => {
  await unmount()
  forgetPrefs()
  window.matchMedia = realMatchMedia
})

const today = localDay()
// Every week on today's weekday.
const WEEKLY = `FREQ=WEEKLY;BYDAY=${WEEKDAYS[(new Date().getDay() + 6) % 7]}`

function reminder(server: FakeServer, title: string) {
  return [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === title)
}

function world({ late = true } = {}) {
  const w = smallWorld()
  const { server, home } = w
  if (late) server.addReminder(home, 'Overdue bins', { due_date: addDays(today, -1) })
  server.addReminder(home, 'Today at nine', { due_date: today, due_time: '09:00' })
  server.addReminder(home, 'Today without time', { due_date: today })
  server.addReminder(home, 'In three days', { due_date: addDays(today, 3) })
  server.addReminder(home, 'Weekly bins', { due_date: today, due_time: '07:30', repeat: WEEKLY, repeat_from: 'due' })
  server.addReminder(home, 'No date')
  return w
}

const days = (page: HTMLElement) => [...page.querySelectorAll<HTMLElement>('[data-testid="day-board"] > section')].map((s) => s.dataset.day)
const column = (page: HTMLElement, day: string) => page.querySelector<HTMLElement>(`[data-testid="day-board"] > section[data-day="${day}"]`)!
const cardTitles = (section: HTMLElement) => [...section.querySelectorAll('[data-reminder]')].map((r) => r.getAttribute('aria-label'))

async function asColumns(page: HTMLElement) {
  await click(page.querySelector('button[aria-label="View"]'))
  await click(page.querySelector('[data-testid="scheduled-look-columns"]'))
}

describe('the arithmetic of the day columns', () => {
  const r = (title: string, due_date: string, due_time: string | null = null) => ({ id: title, title, due_date, due_time }) as Reminder

  it('fits as many columns as keep each between 280 and 420 px, growing with the width', () => {
    expect(DAY_MIN).toBe(280)
    expect(DAY_MAX).toBe(420)
    expect(columnsFor(DAY_MIN)).toBe(1)
    // 1680 px: four of 411 px, not five narrow ones of 327.
    expect(columnsFor(1680)).toBe(4)
    // Room for four of the narrowest: three of 377 px read better.
    expect(columnsFor(DAY_MIN * 4 + DAY_GAP * 3)).toBe(3)
    const width = (w: number) => (w - (columnsFor(w) - 1) * DAY_GAP) / columnsFor(w)
    for (const w of [600, 900, 1200, 1500, 1800, 2400, 3000]) {
      expect(width(w)).toBeGreaterThanOrEqual(DAY_MIN)
      expect(width(w)).toBeLessThanOrEqual(DAY_MAX)
    }
    expect(columnsFor(100)).toBe(1)
    expect(columnsFor(0)).toBe(7)
  })

  it('gives every day from today a column, the empty ones too, in the order of the list', () => {
    const items = [r('a', today), r('b', today, '08:00'), r('c', addDays(today, 4))]
    const { overdue, days: shown } = dayColumns(items, today, 0, 5)
    expect(overdue).toBeNull()
    expect(shown.map((d) => d.day)).toEqual([0, 1, 2, 3, 4].map((n) => addDays(today, n)))
    expect(shown.map((d) => d.items.map((i) => i.id))).toEqual([['a', 'b'], [], [], [], ['c']])
  })

  it('puts what is overdue into a first column of its own, only on the first page', () => {
    const items = [r('old', addDays(today, -3)), r('late', addDays(today, -1)), r('now', today)]
    const first = dayColumns(items, today, 0, 4)
    expect(first.overdue?.map((i) => i.id)).toEqual(['old', 'late'])
    expect(first.days.map((d) => d.day)).toEqual([0, 1, 2].map((n) => addDays(today, n)))
    const next = dayColumns(items, today, 3, 4)
    expect(next.overdue).toBeNull()
    expect(next.days.map((d) => d.day)).toEqual([3, 4, 5, 6].map((n) => addDays(today, n)))
    expect(dayColumns(items, today, -5, 2).days[0].day).toBe(today)
  })
})

describe('"Scheduled" as day columns', () => {
  it('switches in the head between list and columns and keeps the choice on this device', async () => {
    const { server, robin } = world()
    const page = await mount(server, '/scheduled')
    expect(page.querySelector('[data-testid="day-board"]')).toBeNull()
    await asColumns(page)
    expect(page.querySelector('[data-testid="day-board"]')).not.toBeNull()
    expect(localStorage.getItem(prefKey('scheduled.view', robin))).toBe('columns')

    // As after loading the page again: the choice comes back from the device.
    await click(page.querySelector('a[href="/today"]'))
    forgetPrefs()
    await click(page.querySelector('a[href="/scheduled"]'))
    expect(page.querySelector('[data-testid="day-board"]')).not.toBeNull()

    await click(page.querySelector('button[aria-label="View"]'))
    expect(page.querySelector('[data-testid="scheduled-look-columns"]')?.getAttribute('aria-checked')).toBe('true')
    await click(page.querySelector('[data-testid="scheduled-look-list"]'))
    expect(page.querySelector('[data-testid="day-board"]')).toBeNull()
    expect(localStorage.getItem(prefKey('scheduled.view', robin))).toBeNull()
  })

  it('shows every day from today without gaps, "Overdue" first, and pages on by as many days, never before today', async () => {
    const { server } = world()
    const page = await mount(server, '/scheduled')
    await asColumns(page)
    // Without a width to measure (jsdom): seven columns, the first of them "Overdue".
    expect(days(page)).toEqual(['overdue', ...[0, 1, 2, 3, 4, 5].map((n) => addDays(today, n))])
    expect(cardTitles(column(page, 'overdue'))).toEqual(['Overdue bins'])
    expect(cardTitles(column(page, today))).toEqual(['Today without time', 'Weekly bins', 'Today at nine'])
    expect(cardTitles(column(page, addDays(today, 1)))).toEqual([])
    expect(page.querySelector('button[aria-label="Earlier days"]')?.hasAttribute('disabled')).toBe(true)

    await click(page.querySelector('button[aria-label="Later days"]'))
    expect(days(page)).toEqual([6, 7, 8, 9, 10, 11, 12].map((n) => addDays(today, n)))
    await click(page.querySelector('button[aria-label="Earlier days"]'))
    expect(days(page)?.[0]).toBe('overdue')
  })

  it('has no column "Overdue" when nothing is overdue', async () => {
    const { server } = world({ late: false })
    const page = await mount(server, '/scheduled')
    await asColumns(page)
    expect(days(page)).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => addDays(today, n)))
  })

  it('moves a task dragged to another day to that date and keeps its time', async () => {
    const { server } = world()
    const page = await mount(server, '/scheduled')
    await asColumns(page)
    await drag(row(page, 'Today at nine')!, column(page, addDays(today, 2)))
    const moved = reminder(server, 'Today at nine')!.data
    expect(moved.due_date).toBe(addDays(today, 2))
    expect(moved.due_time).toBe('09:00')
    expect(cardTitles(column(page, addDays(today, 2)))).toEqual(['Today at nine'])

    // Onto "Overdue" there is no date to take: nothing changes.
    await drag(row(page, 'In three days')!, column(page, 'overdue'))
    expect(reminder(server, 'In three days')!.data.due_date).toBe(addDays(today, 3))
  })

  it('moves a repeating task as the detail does: its open occurrence gets the date, rule and time stay', async () => {
    const { server } = world()
    const page = await mount(server, '/scheduled')
    await asColumns(page)
    const before = reminder(server, 'Weekly bins')!
    const count = [...server.rows.values()].filter((r) => r.kind === 'reminder').length
    await drag(row(page, 'Weekly bins')!, column(page, addDays(today, 1)))
    const after = reminder(server, 'Weekly bins')!
    expect(after.id).toBe(before.id)
    expect(after.data).toMatchObject({ due_date: addDays(today, 1), due_time: '07:30', repeat: WEEKLY, repeat_from: 'due', completed_at: null })
    expect([...server.rows.values()].filter((r) => r.kind === 'reminder').length).toBe(count)
    // Ticked off there, the moved occurrence is done on its new day and the task goes on by its rule.
    await click(column(page, addDays(today, 1)).querySelector('button[aria-label="Complete “Weekly bins”"]'))
    expect(reminder(server, 'Weekly bins')!.data).toMatchObject({ due_date: addDays(today, 7), due_time: '07:30', repeat: WEEKLY, completed_at: null })
    const copy = [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === 'Weekly bins' && r.id !== before.id)!
    expect(copy.data).toMatchObject({ due_date: addDays(today, 1), repeat: null })
    expect(copy.data.completed_at).toBeTruthy()
    // The very change the detail writes for a new date.
    expect(dueChange(before.data as unknown as Reminder, addDays(today, 1), '07:30')).toEqual({ due_date: addDays(today, 1), due_time: '07:30', repeat: WEEKLY, repeat_from: 'due' })
  })

  it('makes a task on a day with its "+"', async () => {
    const { server } = world()
    const page = await mount(server, '/scheduled')
    await asColumns(page)
    const day = addDays(today, 4)
    await click(column(page, day).querySelector('[data-testid="day-add"]'))
    const field = column(page, day).querySelector('[data-testid="quick-entry"]')
    expect(document.activeElement).toBe(field)
    await type(field, 'Dentist')
    await submit(field)
    expect(reminder(server, 'Dentist')!.data).toMatchObject({ due_date: day, due_time: null, repeat: null })
    expect(cardTitles(column(page, day))).toEqual(['Dentist'])
  })

  it('shows the list and no switch on a phone, whatever was chosen', async () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    const { server, robin } = world()
    setPref('scheduled.view', robin, 'columns')
    const page = await mount(server, '/scheduled')
    expect(page.querySelector('[data-testid="day-board"]')).toBeNull()
    expect(page.querySelector('button[aria-label="View"]')).toBeNull()
    expect(row(page, 'Today at nine')).toBeDefined()
  })
})
