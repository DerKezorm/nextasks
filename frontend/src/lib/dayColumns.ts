/**
 * "Scheduled" as day columns, the arithmetic of it: as many days side by side as the width holds (each at least
 * `DAY_MIN` wide), every day from today on a column of its own, also an empty one; before them a column "Overdue"
 * with every open task of an earlier day, only on the first page and only when there is one. Pages go forward by as
 * many days as they show, never before today.
 */
import { useCallback, useRef, useState } from 'react'

import { addDays } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { useDevicePref } from './devicePref'

/** The narrowest a day column gets. */
export const DAY_MIN = 240
/** The room between two columns. */
export const DAY_GAP = 12
/** Without a width to go by (the page not laid out yet): a week. */
export const DAYS_WITHOUT_WIDTH = 7

export type ScheduledLook = 'list' | 'columns'

/** The look of "Scheduled" on this device; anything else is the list. */
export function parseScheduledLook(raw: string | null): ScheduledLook {
  return raw === 'columns' ? 'columns' : 'list'
}

/** How many columns `width` pixels hold. */
export function columnsFor(width: number): number {
  if (!(width > 0)) return DAYS_WITHOUT_WIDTH
  return Math.max(1, Math.floor((width + DAY_GAP) / (DAY_MIN + DAY_GAP)))
}

export interface DayColumn {
  day: string
  items: Reminder[]
}

/**
 * The columns of the page that begins `start` days after today and holds `count` columns. `items` are the open tasks
 * with a date in the order of the list (date, without a time before with one, time, position); each column keeps it.
 */
export function dayColumns(items: Reminder[], today: string, start: number, count: number): { overdue: Reminder[] | null; days: DayColumn[] } {
  const from = Math.max(0, start)
  const late = items.filter((r) => r.due_date && r.due_date < today)
  const overdue = from === 0 && late.length ? late : null
  const shown = Math.max(1, count - (overdue ? 1 : 0))
  const byDay = new Map<string, Reminder[]>()
  for (const item of items) {
    if (!item.due_date || item.due_date < today) continue
    const group = byDay.get(item.due_date)
    if (group) group.push(item)
    else byDay.set(item.due_date, [item])
  }
  const days: DayColumn[] = []
  for (let n = 0; n < shown; n++) {
    const day = addDays(today, from + n)
    days.push({ day, items: byDay.get(day) ?? [] })
  }
  return { overdue, days }
}

/** List or columns, kept on this device for the account signed in (`nextasks.scheduled.view.<account>`). */
export function useScheduledLook(): [ScheduledLook, (look: ScheduledLook) => void] {
  const [look, set] = useDevicePref('scheduled.view', parseScheduledLook)
  return [look, (next) => set(next === 'list' ? null : next)]
}

export interface DayPaging {
  /** Days after today the page begins with. */
  start: number
  /** Columns the width holds. */
  count: number
  setStart: (start: number) => void
  /** For the element whose width counts. */
  measure: (element: HTMLElement | null) => void
}

/** Where the day columns stand and how many fit; `key` (the page) starts again at today. */
export function useDayPaging(key: string): DayPaging {
  const [state, setState] = useState({ key, start: 0 })
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const measure = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!element) return
    setWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    observer.current = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.current.observe(element)
  }, [])
  const setStart = useCallback((start: number) => setState({ key, start: Math.max(0, start) }), [key])
  return { start: state.key === key ? state.start : 0, count: columnsFor(width), setStart, measure }
}
