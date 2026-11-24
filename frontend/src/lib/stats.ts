/**
 * The review's numbers (`GET /api/stats`, the server's `services/stats.py`) and what the page works out from them:
 * the steps of the heat map, the weeks and months under it, nice steps for an axis, the rate of a series, which year
 * "Your year" offers. Days are `YYYY-MM-DD` in the account's zone; the page reads them as plain days.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

import { api, ApiError } from '../api/client'

export type ListBrief = { id: string; name: string | null; color: string | null; icon: string | null; space_id: string | null; deleted: boolean }
export type StatsPerson = { id: number | null; name: string; me: boolean; former: boolean }
export type Run = { days: number; from: string; to: string }
export type Records = {
  total: number
  best_day: { date: string; count: number } | null
  best_week: { from: string; to: string; count: number } | null
  longest_streak: Run | null
  milestones: { count: number; date: string }[]
  next_milestone: { count: number; missing: number } | null
}
export type Slot = { due_date: string; status: 'on_time' | 'late' | 'skipped'; by: number | null; done_on: string | null }
export type Series = {
  series_id: string
  title: string
  list: ListBrief
  repeat: string
  repeat_from: 'due' | 'completion'
  slots: Slot[]
  next: { due_date: string; due_time: string | null; overdue: boolean } | null
}
export type YearBlock = {
  year: number
  months: number[]
  best_month: number | null
  weekdays: number[]
  best_weekday: number | null
  hours: number[]
  best_hour: number | null
  top_list: { list: ListBrief; count: number } | null
  created: number
  completed: number
  days: number[]
  longest_streak: Run | null
}
export type Stats = {
  scope: {
    space: string
    alone: boolean
    time_zone: string
    today: string
    as_of: string
    spaces: { id: string; name: string; color: string; icon: string; private: boolean; members: number }[]
  }
  people: StatsPerson[]
  range: { kind: Period; year: number | null; from: string; to: string; previous_from: string; previous_to: string }
  total: { count: number; previous: number; change_pct: number | null }
  heatmap: { from: string; to: string; days: number[]; max: number; best: { date: string; count: number } | null }
  streak: { current: number; since: string | null; done_today: boolean; record: number; record_from: string | null; record_to: string | null }
  punctuality: { on_time: number; late: number; percent: number | null }
  duration: { average_days: number | null; median_days: number | null; lists: { list: ListBrief; average_days: number; count: number }[] }
  lists: { list: ListBrief; count: number; share: number }[]
  by_person: { id: number | null; count: number; lists: { list_id: string; count: number }[] }[]
  hours: number[][]
  pulse: Series[]
  week: { from: string; to: string; count: number; previous: number; sentences: string[] }
  records: Records
  records_mine: Records | null
  year: YearBlock | null
}

export type Period = 'week' | 'month' | 'year'
export const PERIODS: Period[] = ['week', 'month', 'year']

export type Load = { state: 'loading' } | { state: 'failed'; code: string } | { state: 'ready'; stats: Stats }

/** The numbers for a space (or `all`) and a period, again whenever one of them changes; the last answer stays while
 * the next one is on its way. */
export function useStats(space: string, period: Period, year: number | null = null): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const asked = useRef(0)
  useEffect(() => {
    const mine = ++asked.current
    const query: Record<string, string | number> = { space, range: period }
    if (year !== null) query.year = year
    api<Stats>('/api/stats', { query }).then(
      (stats) => mine === asked.current && setLoad({ state: 'ready', stats }),
      (error: unknown) => mine === asked.current && setLoad({ state: 'failed', code: error instanceof ApiError ? error.code : 'internal_error' }),
    )
  }, [space, period, year])
  return load
}

/** A day plus `n` days, as a plain date (no zone, no summer time in the way). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + n))
  return date.toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

/** A plain day as a `Date` at noon, for the browser's names of days and months. */
export function dateOf(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

/**
 * The step (0 to 4) of each day in the heat map: 0 for nothing, then by the quarters of the days that had something,
 * so a single busy day does not wash all others out (as GitHub's calendar).
 */
export function heatSteps(days: number[]): number[] {
  const done = days.filter((n) => n > 0).sort((a, b) => a - b)
  if (!done.length) return days.map(() => 0)
  const at = (part: number) => done[Math.min(done.length - 1, Math.floor(part * done.length))]
  const edges = [at(0.25), at(0.5), at(0.75)]
  return days.map((n) => (n <= 0 ? 0 : n <= edges[0] ? 1 : n <= edges[1] ? 2 : n <= edges[2] ? 3 : 4))
}

/** Where a day of a run of days stands in a calendar of weeks (Monday on top): its column and its row. */
export function gridOf(from: string, count: number): { lead: number; columns: number } {
  const lead = weekdayOf(from)
  return { lead, columns: Math.ceil((lead + count) / 7) }
}

/** The columns named by a month above the heat map: each week whose Monday is one of its month's first seven days
 * (the month's first full week), as nextime's year. */
export function monthColumns(from: string, count: number): { column: number; day: string }[] {
  const { lead, columns } = gridOf(from, count)
  const out: { column: number; day: string }[] = []
  for (let column = 0; column < columns; column++) {
    const monday = shiftDay(from, column * 7 - lead)
    if (Number(monday.slice(8)) <= 7) out.push({ column, day: monday })
  }
  return out
}

/** The sums of the last `weeks` runs of seven days, oldest first (the end of `days` is today). */
export function weekSums(days: number[], weeks: number): number[] {
  const out: number[] = []
  for (let w = weeks - 1; w >= 0; w--) {
    const end = days.length - w * 7
    out.push(days.slice(Math.max(0, end - 7), Math.max(0, end)).reduce((a, b) => a + b, 0))
  }
  return out
}

/** The points of the small line in "Done": a week day by day (and the one before), a month and a year by weeks. */
export function sparkOf(days: number[], period: Period): number[] {
  if (period === 'week') return days.slice(-14)
  if (period === 'month') return weekSums(days, 9)
  return weekSums(days, 52)
}

/** Round steps for an axis from 0 to at least `max`: 1, 2 or 5 times a power of ten, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((f) => f * power).find((s) => s >= raw) ?? 10 * power
  const top = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

/** How many of a series' terms were done on time, of all its terms shown (skipped ones count as missed). */
export function pulseRate(slots: Slot[]): number | null {
  if (!slots.length) return null
  return Math.round((100 * slots.filter((s) => s.status === 'on_time').length) / slots.length)
}

/** The weekday and hour when most was done, or null without anything. */
export function peakOf(hours: number[][]): { weekday: number; hour: number; count: number } | null {
  let best: { weekday: number; hour: number; count: number } | null = null
  hours.forEach((row, weekday) =>
    row.forEach((count, hour) => {
      if (count > 0 && (!best || count > best.count)) best = { weekday, hour, count }
    }),
  )
  return best
}

/** Which year "Your year" offers on `today`: in December the running one, in January the one just past, else none. */
export function yearOffered(today: string): number | null {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  if (month === 12) return year
  if (month === 1) return year - 1
  return null
}

/** The milestone before the next one (0 before the first), for the bar between them. */
export function lastMilestone(records: Records): number {
  return records.milestones.length ? records.milestones[records.milestones.length - 1].count : 0
}

/** A whole number as the language writes it ("1.284", "1,284"). */
export function count(n: number, language: string): string {
  return n.toLocaleString(language)
}

/** Days with one place after the point, as the language writes it ("2,4"). */
export function decimal(n: number, language: string): string {
  return n.toLocaleString(language, { minimumFractionDigits: n % 1 ? 1 : 0, maximumFractionDigits: 1 })
}

/** The hour of a day as the language says it ("19 Uhr", "7 PM"). */
export function hourName(hour: number, language: string): string {
  return new Date(2026, 0, 5, hour).toLocaleTimeString(language, { hour: 'numeric' })
}

/** The short and long names of a weekday (0 = Monday). 2026-11-02 was a Monday. */
export function weekdayName(weekday: number, language: string, form: 'short' | 'long' = 'short'): string {
  return dateOf(shiftDay('2026-11-02', weekday)).toLocaleDateString(language, { weekday: form })
}

export function monthName(month: number, language: string, form: 'short' | 'long' | 'narrow' = 'long'): string {
  return new Date(2026, month - 1, 1, 12).toLocaleDateString(language, { month: form })
}

/** A day short ("Sa., 14. März"). */
export function shortDay(day: string, language: string, year = false): string {
  return dateOf(day).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) })
}

/** From and to as one span ("17. bis 23. November" is left to the words; this gives both days short). */
export function dayMonth(day: string, language: string): string {
  return dateOf(day).toLocaleDateString(language, { day: 'numeric', month: 'long' })
}

/** A month and its year ("Dez. 2025"). */
export function monthYear(day: string, language: string): string {
  return dateOf(day).toLocaleDateString(language, { month: 'short', year: 'numeric' })
}

/** The width of the element `ref` points at, followed as it changes (`guess` until it is measured). */
export function useWidth(ref: RefObject<HTMLElement | null>, guess = 640): number {
  const [width, setWidth] = useState(guess)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => node.clientWidth > 0 && setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** The fill of a step of the heat map (0 to 4), from the theme. */
export const heat = (step: number) => `var(--color-heat-${step})`

/** A list's name for the review: a list gone for good has none. */
export function listName(list: ListBrief | undefined, t: (key: string) => string): string {
  return list?.name ?? t('review.deletedList')
}

/** The ISO week of a day (counted from the week with the year's first Thursday), for "Week 11". */
export function isoWeek(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const thursday = new Date(date)
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const january = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  return 1 + Math.floor((thursday.getTime() - january.getTime()) / (7 * 86_400_000))
}
