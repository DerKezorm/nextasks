// The review ("Rückblick") against the fake server with a stand-in for `/api/stats`: the entry in the sidebar, the
// head with period and place in the address, the four numbers, a year of days as a heat map with today marked, who
// took on what in a family, the lists and records alone, the pulse, the week in sentences, a quiet empty state, and
// "Your year" from December on; plus the arithmetic behind the pictures.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { gridOf, heatSteps, isoWeek, monthColumns, niceTicks, peakOf, pulseRate, sparkOf, weekSums, yearOffered, type Stats } from '../lib/stats'
import { FakeServer, smallWorld } from '../test/fakeServer'
import { choose, click, mount, unmount } from '../test/harness'

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
})

const list = (id: string, name: string, color: string) => ({ id, name, color, icon: 'list', space_id: 's1', deleted: false })
const HOME = list('l1', 'Home', 'orange')
const SHOP = list('l2', 'Shop', 'green')

/** Numbers as the server sends them: a family of two, 371 days ending on 24 November 2026. */
function sample(alone = false, total = 1284): Stats {
  const days = Array.from({ length: 371 }, (_, i) => (i % 7 === 5 ? 6 : i % 3))
  return {
    scope: { space: 'all', alone, time_zone: 'Europe/Berlin', today: '2026-11-24', as_of: '2026-11-24T11:40:00.000Z', spaces: [{ id: 's1', name: 'Family', color: 'green', icon: 'house', private: false, members: alone ? 1 : 2 }] },
    people: alone ? [{ id: 1, name: 'Robin', me: true, former: false }] : [{ id: 1, name: 'Robin', me: true, former: false }, { id: 2, name: 'Alex', me: false, former: false }],
    range: { kind: 'year', year: null, from: '2025-11-25', to: '2026-11-24', previous_from: '2024-11-25', previous_to: '2025-11-24' },
    total: { count: total, previous: 1088, change_pct: 18 },
    heatmap: { from: '2025-11-19', to: '2026-11-24', days, max: 6, best: { date: '2026-03-14', count: 21 } },
    streak: { current: 23, since: '2026-11-02', done_today: true, record: 41, record_from: '2026-05-01', record_to: '2026-06-10' },
    punctuality: { on_time: 87, late: 13, percent: 87 },
    duration: { average_days: 2.4, median_days: 0.9, lists: [{ list: SHOP, average_days: 0.8, count: 31 }, { list: HOME, average_days: 3.1, count: 12 }] },
    lists: [{ list: HOME, count: 800, share: 0.623 }, { list: SHOP, count: 484, share: 0.377 }],
    by_person: alone ? [{ id: 1, count: 1284, lists: [{ list_id: 'l1', count: 800 }, { list_id: 'l2', count: 484 }] }] : [{ id: 2, count: 700, lists: [{ list_id: 'l1', count: 500 }, { list_id: 'l2', count: 200 }] }, { id: 1, count: 584, lists: [{ list_id: 'l1', count: 300 }, { list_id: 'l2', count: 284 }] }],
    hours: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 5 && h === 10 ? 40 : h > 17 && h < 22 ? 5 : 0))),
    pulse: [
      {
        series_id: 'r1',
        title: 'Put the bins out',
        list: HOME,
        repeat: 'FREQ=WEEKLY;BYDAY=TU',
        repeat_from: 'due',
        slots: [
          { due_date: '2026-11-03', status: 'on_time', by: 2, done_on: '2026-11-03' },
          { due_date: '2026-11-10', status: 'skipped', by: null, done_on: null },
          { due_date: '2026-11-17', status: 'late', by: 2, done_on: '2026-11-18' },
          { due_date: '2026-11-24', status: 'on_time', by: 1, done_on: '2026-11-24' },
        ],
        next: { due_date: '2026-12-01', due_time: '19:00', overdue: false },
      },
    ],
    week: { from: '2026-11-17', to: '2026-11-23', count: 42, previous: 36, sentences: ['42 tasks done, 6 more than the week before.', 'The strongest day was Saturday with 14.'] },
    records: {
      total,
      best_day: total ? { date: '2026-03-14', count: 21 } : null,
      best_week: total ? { from: '2026-03-09', to: '2026-03-15', count: 64 } : null,
      longest_streak: total ? { days: 41, from: '2026-05-01', to: '2026-06-10' } : null,
      milestones: total ? [{ count: 100, date: '2026-01-12' }, { count: 1000, date: '2026-09-21' }] : [],
      next_milestone: total ? { count: 2500, missing: 2500 - total } : { count: 100, missing: 100 },
    },
    records_mine: null,
    year: null,
  }
}

function yearOf(stats: Stats): Stats {
  const days = Array.from({ length: 365 }, (_, i) => (i % 5 === 0 ? 4 : 1))
  return {
    ...stats,
    range: { ...stats.range, year: 2026, from: '2026-01-01', to: '2026-12-31' },
    year: {
      year: 2026,
      months: [80, 95, 130, 110, 120, 100, 90, 40, 100, 110, 120, 0],
      best_month: 3,
      weekdays: [150, 160, 140, 155, 170, 260, 120],
      best_weekday: 5,
      hours: Array.from({ length: 24 }, (_, h) => (h === 10 ? 50 : 3)),
      best_hour: 10,
      top_list: { list: HOME, count: 410 },
      created: 1350,
      completed: 1284,
      days,
      longest_streak: { days: 41, from: '2026-05-01', to: '2026-06-10' },
    },
  }
}

/** The fake server, and `/api/stats` answered with what `answer` makes of the query. */
class StatsServer extends FakeServer {
  answer: (query: URLSearchParams) => Stats = () => sample()
  asked: string[] = []
  override async handle(method: string, url: string, body: unknown, account: number | null = this.session, headers: Record<string, string> = {}): ReturnType<FakeServer['handle']> {
    const parsed = new URL(url, 'http://fake')
    if (parsed.pathname === '/api/stats') {
      this.asked.push(parsed.search)
      return { status: 200, body: this.answer(parsed.searchParams) }
    }
    return super.handle(method, url, body, account, headers)
  }
}

function world(answer?: (query: URLSearchParams) => Stats) {
  const server = new StatsServer()
  if (answer) server.answer = answer
  const found = smallWorld(server)
  return { ...found, server }
}

const byTest = (page: ParentNode, id: string) => page.querySelector(`[data-testid="${id}"]`)

describe('the review page', () => {
  it('opens from the sidebar above the trash and asks for the period and place in the address', async () => {
    const { server, family } = world()
    const page = await mount(server, '/today')
    const entry = byTest(page, 'review-entry')!
    expect(entry.nextElementSibling?.getAttribute('data-testid')).toBe('trash-entry')
    await click(entry)
    expect(byTest(page, 'review-page')).not.toBeNull()
    expect(server.asked.at(-1)).toBe('?space=all&range=month')
    expect(byTest(page, 'review-sub')?.textContent).toMatch(/^All spaces · one space · as of today/)
    await click([...page.querySelectorAll('[data-testid="review-period"] button')].find((b) => b.textContent === 'Week'))
    expect(server.asked.at(-1)).toBe('?space=all&range=week')
    await choose(byTest(page, 'review-space'), family)
    expect(server.asked.at(-1)).toBe(`?space=${family}&range=week`)
  })

  it('shows the numbers, a year of days, who took on what, when, the pulse and the week', async () => {
    const { server } = world()
    const page = await mount(server, '/review?range=year')
    expect(byTest(page, 'kpi-done')?.textContent).toContain('Done in 12 months1,284+18% on the 12 months before')
    expect(byTest(page, 'kpi-streak')?.textContent).toContain('23 days')
    expect(byTest(page, 'kpi-ontime')?.textContent).toContain('87%')
    expect(byTest(page, 'kpi-open')?.textContent).toContain('2.4 days')
    expect(byTest(page, 'kpi-open')?.textContent).toContain('Shop 0.8')
    const cells = page.querySelectorAll('[data-testid="heatmap"] rect')
    expect(cells).toHaveLength(371)
    const today = page.querySelector('[data-testid="heatmap"] rect[data-day="2026-11-24"]')!
    expect(today.getAttribute('stroke')).toBeTruthy()
    expect(today.querySelector('title')?.textContent).toMatch(/^Today, /)
    // 2025-11-19 was a Wednesday: the first column starts two rows down.
    expect(cells[0].getAttribute('y')).toBe(String(18 + 2 * Number(cells[0].getAttribute('height')) + 2 * 3))
    expect(byTest(page, 'heat-card')?.textContent).toContain('best day')
    const people = page.querySelectorAll('[data-testid="who-bars"] [data-person]')
    expect([...people].map((p) => p.getAttribute('data-person'))).toEqual(['2', '1'])
    // To scale: Alex's home part is 500/300 of Robin's.
    const part = (person: string, l: string) => Number(page.querySelector(`[data-person="${person}"] rect[data-list="${l}"]`)!.getAttribute('width')) + 1.5
    expect(part('2', 'l1') / part('1', 'l1')).toBeCloseTo(500 / 300, 1)
    expect(byTest(page, 'when-peak')?.textContent).toBe('Most gets ticked off on Saturday around 10 AM.')
    expect(page.querySelectorAll('[data-testid="punchcard"] circle').length).toBe(1 + 7 * 4)
    const slots = page.querySelectorAll('[data-series="r1"] [data-status]')
    expect([...slots].map((s) => s.textContent)).toEqual(['A', '', 'A', 'R'])
    expect(page.querySelectorAll('[data-series="r1"] [aria-hidden].border-dashed')).toHaveLength(12)
    expect(byTest(page, 'pulse-rate')?.textContent).toBe('50% on time')
    expect(byTest(page, 'week-card')?.textContent).toContain('The strongest day was Saturday with 14.')
    expect(byTest(page, 'records-card')).toBeNull()
  })

  it('alone shows the lists and the records instead of the people, and no letters', async () => {
    const { server } = world(() => sample(true))
    const page = await mount(server, '/review')
    expect(byTest(page, 'who-card')).toBeNull()
    expect(page.querySelectorAll('[data-testid="list-shares"] [data-list]')).toHaveLength(2)
    expect(byTest(page, 'records')?.textContent).toContain('Best day21')
    expect(byTest(page, 'records')?.textContent).toContain('1,216 more until task number 2,500.')
    expect([...page.querySelectorAll('[data-series="r1"] [data-status]')].map((s) => s.textContent)).toEqual(['', '', '', ''])
  })

  it('without anything done shows a quiet empty state, no pictures', async () => {
    const { server } = world(() => sample(false, 0))
    const page = await mount(server, '/review')
    expect(byTest(page, 'empty-state')?.textContent).toContain('Nothing done yet')
    expect(byTest(page, 'heatmap')).toBeNull()
  })

  it('offers "Your year" from December to January, and its card at its address any time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 11, 3, 12))
    const { server } = world((query) => (query.get('year') ? yearOf(sample()) : sample()))
    const page = await mount(server, '/review')
    expect(byTest(page, 'year-entry')?.textContent?.trim()).toBe('Your 2026')
    await click(byTest(page, 'year-teaser'))
    expect(server.asked.at(-1)).toBe('?space=all&range=year&year=2026')
    const card = byTest(page, 'year-card')!
    expect(byTest(card, 'year-count')?.textContent).toBe('1,284')
    expect(card.textContent).toContain('tasks you all got done together in 2026')
    expect(card.textContent).toContain('196 more than in 2025')
    expect(card.textContent).toContain('March')
    expect(card.querySelectorAll('[data-person]')).toHaveLength(2)
    expect(byTest(page, 'year-save')?.textContent).toBe('Save as picture')
    vi.setSystemTime(new Date(2026, 10, 24, 12))
    await unmount()
    const later = await mount(world().server, '/review')
    expect(byTest(later, 'year-entry')).toBeNull()
    expect(byTest(later, 'year-teaser')).toBeNull()
  })
})

describe('the arithmetic of the pictures', () => {
  it('steps the heat map by quarters of the days with something', () => {
    expect(heatSteps([0, 1, 2, 3, 4, 40])).toEqual([0, 1, 1, 2, 3, 4])
    expect(heatSteps([0, 0])).toEqual([0, 0])
  })

  it('lays days into weeks from Monday and names each month at its first full week', () => {
    expect(gridOf('2025-11-19', 371)).toEqual({ lead: 2, columns: 54 })
    const months = monthColumns('2025-11-19', 371)
    expect(months[0]).toEqual({ column: 2, day: '2025-12-01' })
    expect(months).toHaveLength(12)
  })

  it('finds round steps, sums of weeks, rates, peaks, ISO weeks and the year offered', () => {
    expect(niceTicks(584)).toEqual([0, 200, 400, 600])
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8])
    expect(weekSums([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2], 2)).toEqual([7, 14])
    expect(sparkOf(Array(371).fill(1), 'week')).toHaveLength(14)
    expect(sparkOf(Array(371).fill(1), 'year')).toHaveLength(52)
    expect(pulseRate([{ due_date: '2026-11-03', status: 'on_time', by: 1, done_on: null }, { due_date: '2026-11-10', status: 'skipped', by: null, done_on: null }])).toBe(50)
    expect(peakOf([[0, 3], [5, 0]])).toEqual({ weekday: 1, hour: 0, count: 5 })
    expect(isoWeek('2026-03-09')).toBe(11)
    expect(isoWeek('2027-01-01')).toBe(53)
    expect(yearOffered('2026-12-01')).toBe(2026)
    expect(yearOffered('2027-01-31')).toBe(2026)
    expect(yearOffered('2026-11-30')).toBeNull()
  })
})
