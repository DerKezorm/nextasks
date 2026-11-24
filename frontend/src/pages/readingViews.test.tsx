// The views of tasks as cards in a reading column, the sidebar with plaques, red numbers and parts that stay folded on
// this device, the small buttons of a row, quiet empty pages, and no family parts for someone on their own.
import { afterEach, describe, expect, it } from 'vitest'

import { forgetPrefs, prefKey, setPref } from '../lib/devicePref'
import { localDay } from '../lib/due'
import { colorOf } from '../lib/look'
import { isAlone, isShared, isSharedList } from '../lib/shared'
import { addDays } from '../sync/repeat'
import type { Member, Space } from '../sync/types'
import { FakeServer, smallWorld } from '../test/fakeServer'
import { button, click, mount, row, unmount } from '../test/harness'

afterEach(async () => {
  await unmount()
  forgetPrefs()
})

const today = localDay()
const hexToRgb = (hex: string) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`

function reminder(server: FakeServer, title: string) {
  return [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === title)
}

function world() {
  const w = smallWorld()
  const { server, home, privateList, robin, alex } = w
  server.addReminder(home, 'Overdue bins', { due_date: addDays(today, -2) })
  server.addReminder(home, 'Shared one', { assignees: [alex] })
  server.addReminder(privateList, 'Private thought', { assignees: [robin] })
  // A space of Robin's own that nobody joined.
  const solo = server.addSpace('Workshop', robin, { color: 'teal', icon: 'hammer' })
  const bench = server.addList(solo, 'Bench', { color: 'teal' })
  server.addReminder(bench, 'Sharpen chisel', { assignees: [robin] })
  return { ...w, solo, bench }
}

describe('who shares a place', () => {
  const space = (id: string, own = false) => ({ id, private: own }) as Space
  const members = (n: number) => Array.from({ length: n }, (_, i) => ({ account_id: i + 1 }) as Member)
  const view = (counts: Record<string, number>, spaces: Space[] = []) => ({
    membersOf: (id: string) => members(counts[id] ?? 0),
    shownSpaces: spaces,
    list: (id: string) => (id === 'l' ? { id: 'l', space_id: 'family' } : undefined) as never,
    space: (id: string) => spaces.find((s) => s.id === id),
  })

  it('counts a space as shared only when it is not "Private" and has another member', () => {
    expect(isShared(view({ family: 2 }), space('family'))).toBe(true)
    expect(isShared(view({ family: 1 }), space('family'))).toBe(false)
    expect(isShared(view({ mine: 3 }), space('mine', true))).toBe(false)
    expect(isShared(view({}), undefined)).toBe(false)
  })

  it('knows a shared list and someone alone', () => {
    const spaces = [space('mine', true), space('family')]
    expect(isSharedList(view({ family: 2 }, spaces), 'l')).toBe(true)
    expect(isSharedList(view({ family: 1 }, spaces), 'l')).toBe(false)
    expect(isAlone(view({ family: 1 }, spaces))).toBe(true)
    expect(isAlone(view({ family: 2 }, spaces))).toBe(false)
  })
})

describe('the sidebar', () => {
  it('shows a list with a plaque in its colour and a white symbol, and the red number of overdue ones', async () => {
    const { server, home } = world()
    const page = await mount(server, '/today')
    const entry = page.querySelector(`aside [data-testid="list-Home"]`)!
    const plaque = entry.querySelector<HTMLElement>('[data-plaque]')!
    expect(plaque.style.background).toBe(hexToRgb(colorOf(server.data('list', home)!.color as string)))
    expect(plaque.querySelector<SVGElement>('svg[data-mark]')!.style.color).toBe('rgb(255, 255, 255)')
    expect(entry.querySelector('[data-testid="late-count"]')?.textContent).toContain('1')
    expect(page.querySelector('[data-testid="tile-count-today-late"]')?.textContent).toContain('1')
    expect(page.querySelector('[data-testid="tile-count-today"]')?.textContent).toBe('1')
  })

  it('shows today\'s day of the month in the symbol of "Today"', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    expect(page.querySelector('[data-testid="tile-today"] [data-today-icon]')?.textContent).toBe(String(new Date().getDate()))
  })

  it('folds a space and keeps it folded on this device', async () => {
    const { server, family, robin } = world()
    const page = await mount(server, '/today')
    const head = () => page.querySelector(`aside [data-space="${family}"] button[aria-expanded]`)!
    await click(head())
    expect(head().getAttribute('aria-expanded')).toBe('false')
    expect(page.querySelector('aside [data-testid="list-Home"]')).toBeNull()
    expect(localStorage.getItem(prefKey(`sidebar.fold.space.${family}`, robin))).toBe('shut')
    await click(head())
    expect(localStorage.getItem(prefKey(`sidebar.fold.space.${family}`, robin))).toBeNull()
  })

  it('opens folded as it was left', async () => {
    const { server, family, robin } = world()
    setPref(`sidebar.fold.space.${family}`, robin, 'shut')
    const page = await mount(server, '/today')
    expect(page.querySelector(`aside [data-space="${family}"] button[aria-expanded]`)?.getAttribute('aria-expanded')).toBe('false')
    expect(page.querySelector('aside [data-testid="list-Home"]')).toBeNull()
    expect(page.querySelector('aside [data-testid="list-Bench"]')).not.toBeNull()
  })

  it('shows the members in the head of a shared space only', async () => {
    const { server, family, solo } = world()
    const page = await mount(server, '/today')
    expect(page.querySelector(`aside [data-space="${family}"] [role="img"][aria-label^="Assigned"]`)).not.toBeNull()
    expect(page.querySelector(`aside [data-space="${solo}"] [role="img"][aria-label^="Assigned"]`)).toBeNull()
  })
})

describe('the cards of a page', () => {
  it('puts a list into the reading column, each section a card with its head inside', async () => {
    const { server, home } = world()
    const shelf = server.addSection(home, 'Shelf', 'a0')
    server.addReminder(home, 'On the shelf', { section_id: shelf })
    const page = await mount(server, `/lists/${home}`)
    expect(page.querySelector('main .nt-read')).not.toBeNull()
    const card = row(page, 'On the shelf')!.closest('.nt-group')!
    expect(card.querySelector(`[data-section-id="${shelf}"]`)?.textContent).toContain('Shelf')
    expect(card.querySelector('[data-testid="quick-entry"]')).not.toBeNull()
  })

  it('groups "All" by list, each a card with the list in its head and a way to open it', async () => {
    const { server } = world()
    const page = await mount(server, '/all')
    const card = row(page, 'Shared one')!.closest('.nt-group')!
    expect(card.querySelector('[data-testid="card-head"]')?.textContent).toContain('Home')
    expect(card.querySelector('a[href^="/lists/"]')).not.toBeNull()
  })
})

describe('the buttons of a row', () => {
  it('set the date, the assignees and the mark of a task in a shared space', async () => {
    const { server, alex } = world()
    const page = await mount(server, '/all')
    const shared = () => row(page, 'Shared one')!
    expect(shared().querySelector('[data-testid="row-actions"]')).not.toBeNull()
    await click(shared().querySelector('button[aria-label="Date"]'))
    await click(button(shared(), 'Tomorrow'))
    expect(reminder(server, 'Shared one')!.data.due_date).toBe(addDays(today, 1))
    await click(shared().querySelector('button[aria-label="Assignees"]'))
    const alexEntry = [...shared().querySelectorAll('[role="menuitemcheckbox"]')].find((b) => b.textContent?.includes('Alex'))!
    expect(alexEntry.getAttribute('aria-checked')).toBe('true')
    await click(alexEntry)
    expect(reminder(server, 'Shared one')!.data.assignees).toEqual([])
    expect(reminder(server, 'Shared one')!.data.assignees).not.toContain(alex)
    await click(shared().querySelector('[data-testid="row-mark"]'))
    expect(reminder(server, 'Shared one')!.data.flagged).toBe(true)
  })

  it('pick a day and take no date', async () => {
    const { server } = world()
    const page = await mount(server, '/all')
    const bins = () => row(page, 'Overdue bins')!
    await click(bins().querySelector('button[aria-label="Date"]'))
    await click(bins().querySelector('[data-testid="row-pick-date"]'))
    const field = bins().querySelector<HTMLInputElement>('[data-testid="row-date-field"]')!
    expect(document.activeElement).toBe(field)
    const day = addDays(today, 10)
    const { act } = await import('react')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(field, day)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button(bins(), 'Set'))
    expect(reminder(server, 'Overdue bins')!.data.due_date).toBe(day)
    await click(bins().querySelector('button[aria-label="Date"]'))
    await click(button(bins(), 'No date'))
    expect(reminder(server, 'Overdue bins')!.data.due_date).toBeNull()
  })

  it('offer no assignees and show no avatars where one is alone', async () => {
    const { server } = world()
    const page = await mount(server, '/all')
    for (const title of ['Private thought', 'Sharpen chisel']) {
      const own = row(page, title)!
      expect(own.querySelector('[data-testid="row-actions"]')).not.toBeNull()
      expect(own.querySelector('button[aria-label="Assignees"]')).toBeNull()
      expect(own.querySelector('[aria-label^="Assigned"]')).toBeNull()
    }
    expect(row(page, 'Shared one')!.querySelector('[aria-label^="Assigned"]')).not.toBeNull()
  })
})

describe('empty pages', () => {
  it('say that today is done and how many wait for tomorrow', async () => {
    const { server, privateList } = smallWorld()
    server.addReminder(privateList, 'Tomorrow one', { due_date: addDays(today, 1) })
    server.addReminder(privateList, 'Tomorrow two', { due_date: addDays(today, 1) })
    const page = await mount(server, '/today')
    const empty = page.querySelector('[data-testid="today-calm"]')!
    expect(empty.textContent).toContain('All done for today')
    expect(empty.textContent).toContain('2 tasks are due tomorrow.')
    expect(page.querySelector('[data-testid="quick-entry"]')).not.toBeNull()
  })

  it('lead an empty list of one\'s own to its quick entry, and a shared one says who sees it', async () => {
    const { server, robin, family } = smallWorld()
    const own = server.addList(server.addSpace('Garage', robin), 'Tools')
    let page = await mount(server, `/lists/${own}`)
    expect(page.querySelector('[data-testid="empty-state"]')?.textContent).toContain('Type your first task in the line below')
    expect(page.querySelector('[data-testid="quick-entry"]')).not.toBeNull()
    await unmount()
    const errands = server.addList(family, 'Errands')
    page = await mount(server, `/lists/${errands}`)
    expect(page.querySelector('[data-testid="empty-state"]')?.textContent).toContain('Everyone in “Family” sees')
  })
})
