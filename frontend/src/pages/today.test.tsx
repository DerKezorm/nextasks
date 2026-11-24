// "Today" as a page of the day: the three cards with what was ticked off today, "All to today", the timeline with the
// line of now, the week band (a click leads to the day, a drop moves there), the focus of the day on the server, the
// right column shared and alone, "Plan tomorrow", the quiet card once nothing is left.
import { afterEach, describe, expect, it } from 'vitest'

import { localDay } from '../lib/due'
import { fromNow, nowIndex } from '../lib/today'
import { addDays } from '../sync/repeat'
import { FakeServer, smallWorld } from '../test/fakeServer'
import { button, click, drag, mount, row, settle, unmount, where } from '../test/harness'

afterEach(unmount)

const today = localDay()
const tomorrow = addDays(today, 1)

function reminder(server: FakeServer, title: string) {
  return [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === title)
}

function world() {
  const w = smallWorld()
  const { server, home, robin } = w
  server.addReminder(home, 'Overdue bins', { due_date: addDays(today, -1) })
  server.addReminder(home, 'Early call', { due_date: today, due_time: '00:01' })
  server.addReminder(home, 'Late pickup', { due_date: today, due_time: '23:58' })
  server.addReminder(home, 'Today without time', { due_date: today })
  server.addReminder(home, 'Swept already', { due_date: today, completed_at: new Date().toISOString(), completed_by: robin })
  server.addReminder(home, 'Tomorrow bins', { due_date: tomorrow, due_time: '19:00' })
  server.addReminder(home, 'No date')
  return w
}

const card = (page: HTMLElement, name: string) => page.querySelector<HTMLElement>(`[data-testid="card-${name}"]`)!
const titlesIn = (part: HTMLElement) => [...part.querySelectorAll('[data-reminder]')].map((r) => r.getAttribute('aria-label'))

function stats(alone: boolean, people: { id: number; done: number; due: number; due_done: number }[] = []) {
  return {
    scope: { alone, today },
    people: [
      { id: 1, name: 'Robin', me: true, former: false },
      { id: 2, name: 'Alex', me: false, former: false },
    ],
    heatmap: { from: addDays(today, -370), to: today, days: [...Array(364).fill(0), 2, 5, 1, 0, 3, 4, 1] },
    streak: { current: 12, done_today: true, record: 20 },
    today: { date: today, done: 1, due: 4, due_done: 1, open: 3, overdue: 1, people },
  }
}

describe('the words of time', () => {
  it('say how far a time is from now, by halves of an hour', () => {
    expect(fromNow('16:15', '12:40')).toEqual({ key: 'inHours', value: '3½', late: false })
    expect(fromNow('10:00', '12:05')).toEqual({ key: 'sinceHours', value: '2', late: true })
    expect(fromNow('12:55', '12:40')).toEqual({ key: 'inMinutes', value: '15', late: false })
    expect(fromNow('12:40', '12:40').key).toBe('now')
    expect(nowIndex([{ due_time: '08:00' }, { due_time: '10:00' }, { due_time: '16:15' }], '12:40')).toBe(2)
    expect(nowIndex([{ due_time: '08:00' }], '12:40')).toBe(1)
  })
})

describe('Today', () => {
  it('parts the day into overdue, with a time and some time today, and keeps what was done today ticked', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    expect(titlesIn(card(page, 'overdue'))).toEqual(['Overdue bins'])
    expect(titlesIn(card(page, 'timed'))).toEqual(['Early call', 'Late pickup'])
    expect(titlesIn(card(page, 'anytime'))).toEqual(['Today without time', 'Swept already'])
    // The line of now stands between the past and the coming time.
    const timeline = card(page, 'timed')
    const line = timeline.querySelector('[data-testid="now-line"]')!
    expect(line.compareDocumentPosition(row(timeline, 'Late pickup')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line.compareDocumentPosition(row(timeline, 'Early call')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(row(timeline, 'Early call')!.querySelector('[data-testid="from-now"]')?.textContent).toMatch(/ago$/)
    expect(row(timeline, 'Late pickup')!.querySelector('[data-testid="from-now"]')?.textContent).toMatch(/^in /)
    const swept = row(page, 'Swept already')!
    expect(swept.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    expect(swept.querySelector('[data-testid="done-by"]')?.textContent).toMatch(/^done by Robin, \d\d:\d\d$/)
    expect(page.querySelector('header')?.textContent).toContain(' · from all spaces')
    // Tomorrow on the right, not among the rows.
    expect(page.querySelector('[data-testid="today-tomorrow"]')?.textContent).toContain('Tomorrow bins · 19:00')
    expect(row(page, 'Tomorrow bins')).toBeUndefined()
    // 1 of 4 due today done, 3 of them still open and the overdue one besides: the 4 open of the head.
    expect(page.querySelector('[data-testid="progress-line"]')?.textContent).toBe('1 of 4 for today done')
    expect(page.querySelector('[data-testid="today-progress"]')?.textContent).toContain('3 still open · plus one overdue')
    expect(page.querySelector('header')?.textContent).toContain('4 open tasks, one of them overdue')
  })

  it('moves every overdue task to today at once', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    await click(page.querySelector('[data-testid="all-to-today"]'))
    await settle()
    expect(reminder(server, 'Overdue bins')!.data.due_date).toBe(today)
    expect(page.querySelector('[data-testid="card-overdue"]')).toBeNull()
  })

  it('shows the next seven days in the band; a click opens the day in Scheduled, a drop moves the task there', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    const days = [...page.querySelectorAll<HTMLElement>('[data-testid="band-day"]')]
    expect(days.map((d) => d.dataset.day)).toEqual(Array.from({ length: 7 }, (_, n) => addDays(today, n)))
    expect(days[1].textContent).toContain('1 · Tomorrow bins')
    await drag(row(page, 'Today without time')!, days[3])
    expect(reminder(server, 'Today without time')!.data.due_date).toBe(addDays(today, 3))
    await click(days[1])
    expect(where.path).toBe(`/scheduled?day=${tomorrow}`)
  })

  it('keeps up to three tasks in focus on the server, by the star in the row or by dropping them on the card', async () => {
    const { server, robin } = world()
    const page = await mount(server, '/today')
    await click(row(page, 'Late pickup')!.querySelector('[data-testid="row-focus"]'))
    await settle()
    expect(server.focus.get(robin)).toEqual([reminder(server, 'Late pickup')!.id])
    const focusCard = page.querySelector<HTMLElement>('[data-testid="today-focus"]')!
    await drag(row(page, 'Today without time')!, focusCard)
    await click(row(page, 'Overdue bins')!.querySelector('[data-testid="row-focus"]'))
    await settle()
    expect([...focusCard.querySelectorAll('[data-testid="focus-item"]')].map((i) => i.textContent)).toEqual(['1Late pickup', '2Today without time', '3Overdue bins'])
    // Three is the most: the star of a fourth waits.
    expect(row(page, 'Early call')!.querySelector('[data-testid="row-focus"]')?.hasAttribute('disabled')).toBe(true)
    // A task gone to the bin falls out.
    server.change('reminder', reminder(server, 'Overdue bins')!.id, { deleted_at: new Date().toISOString() })
    await unmount()
    const again = await mount(server, '/today')
    expect(again.querySelectorAll('[data-testid="focus-item"]')).toHaveLength(2)
  })

  it('shows the family\'s day where others share a space, and "Your week" alone', async () => {
    const shared = world()
    shared.server.stats = stats(false, [
      { id: 1, done: 1, due: 2, due_done: 1 },
      { id: 2, done: 0, due: 1, due_done: 0 },
    ])
    let page = await mount(shared.server, '/today')
    expect([...page.querySelectorAll('[data-testid="family-person"]')].map((p) => p.textContent)).toEqual(['RRobin1 / 2', 'AAlex0 / 1'])
    expect(page.querySelector('[data-testid="today-your-week"]')).toBeNull()
    expect(page.querySelector('[data-testid="today-progress"]')?.textContent).toContain('Run: 12 days')
    await unmount()

    const server = new FakeServer()
    const solo = server.addAccount('Sam')
    server.session = solo
    const list = [...server.rows.values()].find((r) => r.kind === 'list')!.id
    server.addReminder(list, 'Run 5 km', { due_date: today })
    server.stats = stats(true)
    page = await mount(server, '/today')
    expect(page.querySelector('[data-testid="today-family"]')).toBeNull()
    expect(page.querySelector('[data-testid="today-your-week"] svg')?.getAttribute('aria-label')).toBe('Done on the last seven days: 2, 5, 1, 0, 3, 4, 1')
    expect(page.querySelector('[data-testid="today-focus"]')).not.toBeNull()
  })

  it('plans tomorrow: what stayed open goes to tomorrow, some time or the bin (all at once after a question)', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    await click(page.querySelector('[data-testid="plan-tomorrow-open"]'))
    const dialog = document.querySelector<HTMLElement>('[data-testid="plan-tomorrow"]')!
    expect([...dialog.querySelectorAll('[data-testid="plan-item"]')]).toHaveLength(4)
    expect(dialog.querySelector('[data-testid="plan-coming"]')?.textContent).toContain('Tomorrow bins')
    await click(button(dialog, '“Overdue bins” to tomorrow'))
    await click(button(dialog, '“Today without time” some time'))
    await settle()
    expect(reminder(server, 'Overdue bins')!.data.due_date).toBe(tomorrow)
    expect(reminder(server, 'Today without time')!.data.due_date).toBeNull()
    await click(dialog.querySelector('[data-testid="plan-all-trash"]'))
    expect(document.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull()
    await click(document.querySelector('[data-testid="confirm-go"]'))
    await settle()
    expect(reminder(server, 'Late pickup')!.data.deleted_at).toBeTruthy()
    expect(reminder(server, 'Early call')!.data.deleted_at).toBeTruthy()
    expect(document.querySelector('[data-testid="plan-nothing"]')).not.toBeNull()
  })

  it('says so quietly once nothing is left, with what tomorrow brings', async () => {
    const { server, home } = smallWorld()
    server.addReminder(home, 'Done early', { due_date: today, completed_at: new Date().toISOString(), completed_by: 1 })
    server.addReminder(home, 'Tomorrow bins', { due_date: tomorrow })
    const page = await mount(server, '/today')
    const calm = page.querySelector('[data-testid="today-calm"]')!
    expect(calm.textContent).toContain('All done for today')
    expect(calm.textContent).toContain('Tomorrow bins')
    expect(row(page, 'Done early')).toBeDefined()
  })
})
