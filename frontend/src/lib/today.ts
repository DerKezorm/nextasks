/**
 * "Today" as a page of the day: what goes into its three cards (overdue, with a time, some time today), the seven days
 * of the week band, how far the day got, what is left for "Plan tomorrow". What was ticked off today stays in its card,
 * ticked, until the next day. Days are the browser's, as everywhere on the page.
 */
import { addDays } from '../sync/repeat'
import { byCompletion, byDue, localDayOf } from '../sync/tiles'
import type { Reminder } from '../sync/types'
import type { View } from '../sync/view'
import { byPosition } from '../sync/position'
import { copyId } from '../sync/complete'

/** Ticked off today (in the browser's day). */
export function doneToday(reminder: Pick<Reminder, 'completed_at'>, today: string): boolean {
  return !!reminder.completed_at && localDayOf(reminder.completed_at) === today
}

/** Open and due today or earlier, or ticked off today with such a date. */
function ofToday(reminder: Reminder, today: string): boolean {
  if (!reminder.due_date || reminder.due_date > today) return false
  return !reminder.completed_at || doneToday(reminder, today)
}

/** Open ones first in their order, those done today after them, the first done on top. */
function openThenDone(order: (a: Reminder, b: Reminder) => number) {
  return (a: Reminder, b: Reminder) => {
    if (!a.completed_at !== !b.completed_at) return a.completed_at ? 1 : -1
    if (a.completed_at) return -byCompletion(a, b)
    return order(a, b)
  }
}

export interface TodayCards {
  overdue: Reminder[]
  timed: Reminder[]
  anytime: Reminder[]
  /** Every task of the three cards (subtasks included), for the subtasks shown under their task. */
  all: Reminder[]
  /** Still open in the cards. */
  open: number
}

export function todayCards(view: View, today: string): TodayCards {
  const all = view.visible.filter((r) => ofToday(r, today))
  const overdue = all.filter((r) => r.due_date! < today).sort(openThenDone(byDue))
  // The timeline keeps the order of the clock, done or not.
  const timed = all.filter((r) => r.due_date === today && r.due_time).sort((a, b) => (a.due_time! < b.due_time! ? -1 : a.due_time! > b.due_time! ? 1 : byPosition(a, b)))
  const anytime = all.filter((r) => r.due_date === today && !r.due_time).sort(openThenDone(byPosition))
  return { overdue, timed, anytime, all, open: all.filter((r) => !r.completed_at).length }
}

/** Top-level rows only: a subtask whose parent shows too appears under it. */
export function topRows(items: Reminder[], all: Reminder[]): Reminder[] {
  const shown = new Set(all.map((r) => r.id))
  return items.filter((r) => !r.parent_id || !shown.has(r.parent_id))
}

/** How far today got: tasks due today (not their subtasks) and how many of them are done. */
export function progressOf(cards: TodayCards): { due: number; done: number; overdue: number } {
  const tops = topRows([...cards.timed, ...cards.anytime], cards.all)
  return { due: tops.length, done: tops.filter((r) => r.completed_at).length, overdue: topRows(cards.overdue, cards.all).filter((r) => !r.completed_at).length }
}

export interface BandDay {
  day: string
  count: number
  /** Open tasks per list, in the order of the sidebar: the coloured bars. */
  lists: { listId: string; count: number }[]
  /** The first open task of the day (by time and position). */
  first: Reminder | null
  /** Today: the open overdue ones besides. */
  late: number
}

/** The seven days from today: open tasks per day (subtasks count, as in "Scheduled"). */
export function weekBand(view: View, today: string): BandDay[] {
  const open = view.visible.filter((r) => !r.completed_at && r.due_date).sort(byDue)
  return Array.from({ length: 7 }, (_, n) => {
    const day = addDays(today, n)
    const items = open.filter((r) => r.due_date === day)
    const counts = new Map<string, number>()
    for (const r of items) counts.set(r.list_id, (counts.get(r.list_id) ?? 0) + 1)
    const lists = [...counts].map(([listId, count]) => ({ listId, count })).sort((a, b) => view.listIndex(a.listId) - view.listIndex(b.listId))
    return { day, count: items.length, lists, first: items[0] ?? null, late: n === 0 ? open.filter((r) => r.due_date! < today).length : 0 }
  })
}

/** Open tasks due on `day` (top-level), as the list sorts them. */
export function dueOn(view: View, day: string): Reminder[] {
  const items = view.visible.filter((r) => !r.completed_at && r.due_date === day).sort(byDue)
  return topRows(items, items)
}

/** What is left open of today and before: for "Plan tomorrow" (top-level tasks). */
export function leftOpen(view: View, today: string): Reminder[] {
  const items = view.visible.filter((r) => !r.completed_at && r.due_date && r.due_date <= today).sort(byDue)
  return topRows(items, items)
}

/**
 * A time against now in words: "in 3½ h" before it, "2 h ago" after it, minutes under an hour, "now" within a
 * minute. Hours go by halves. `now` and `time` are "HH:MM" of the same day.
 */
export function fromNow(time: string, now: string): { key: 'now' | 'inMinutes' | 'inHours' | 'sinceMinutes' | 'sinceHours'; value: string; late: boolean } {
  const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
  const diff = minutes(time) - minutes(now)
  const late = diff < 0
  const span = Math.abs(diff)
  if (span < 1) return { key: 'now', value: '', late: false }
  if (span < 60) return { key: late ? 'sinceMinutes' : 'inMinutes', value: String(span), late }
  const halves = Math.round(span / 30)
  const whole = Math.floor(halves / 2)
  return { key: late ? 'sinceHours' : 'inHours', value: halves % 2 ? `${whole}½` : String(whole), late }
}

/** Where the line of now goes in the timeline: before the first task whose time is still to come. */
export function nowIndex(timed: Pick<Reminder, 'due_time'>[], now: string): number {
  const at = timed.findIndex((r) => (r.due_time ?? '') > now)
  return at < 0 ? timed.length : at
}

/**
 * A task in focus as it reads now: itself, or, when it repeats and today's occurrence was ticked off (the task moved
 * on to its next date), the done copy of that occurrence. Gone (bin, hidden space) is null.
 */
export function focusTask(view: View, id: string, today: string, visible: Set<string>): Reminder | null {
  const reminder = view.reminder(id)
  if (!reminder || !visible.has(id)) return null
  if (!reminder.repeat || !reminder.due_date || reminder.due_date <= today) return reminder
  // The occurrence done today lay on or before today; look back a few weeks for its copy.
  for (let back = 0; back <= 31; back++) {
    const copy = view.reminder(copyId(id, addDays(today, -back)))
    if (copy && visible.has(copy.id) && doneToday(copy, today)) return copy
  }
  return reminder
}
