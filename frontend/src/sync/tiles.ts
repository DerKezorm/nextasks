/**
 * The tiles at the top of the sidebar (data model, "Kacheln"). They count open reminders outside the trash, subtasks
 * included; "Done" has no number. Spaces one hid (`space_pref`) do not count. Next to them the own filters (data
 * model, "Eigener Filter"), which go through the same reminders by their own conditions.
 */
import { byPosition } from './position'
import { addDays } from './repeat'
import type { Reminder } from './types'
import type { View } from './view'

export const TILES = ['today', 'scheduled', 'all', 'flagged', 'assigned', 'done'] as const
export type Tile = (typeof TILES)[number]

/** The fixed id of each collection, for hiding it (`tile_pref`). */
export const TILE_IDS: Record<Tile, string> = {
  today: '00000000-0000-4000-8000-0000000000a1',
  scheduled: '00000000-0000-4000-8000-0000000000a2',
  all: '00000000-0000-4000-8000-0000000000a3',
  flagged: '00000000-0000-4000-8000-0000000000a4',
  assigned: '00000000-0000-4000-8000-0000000000a5',
  done: '00000000-0000-4000-8000-0000000000a6',
}

/** The collections the sidebar shows: those one did not hide. */
export function shownTiles(view: View): Tile[] {
  return TILES.filter((tile) => !view.isTileHidden(TILE_IDS[tile]))
}

function open(view: View): Reminder[] {
  return view.visible.filter((r) => !r.completed_at)
}

/** Due date, without a time before with one, the time, position, id. */
export function byDue(a: Reminder, b: Reminder): number {
  if ((a.due_date ?? '') !== (b.due_date ?? '')) {
    if (!a.due_date) return 1
    if (!b.due_date) return -1
    return a.due_date < b.due_date ? -1 : 1
  }
  if (!a.due_time !== !b.due_time) return a.due_time ? 1 : -1
  if ((a.due_time ?? '') !== (b.due_time ?? '')) return (a.due_time ?? '') < (b.due_time ?? '') ? -1 : 1
  return byPosition(a, b)
}

/** Completed last first; at the same moment by position. */
export function byCompletion(a: Reminder, b: Reminder): number {
  return a.completed_at! < b.completed_at! ? 1 : a.completed_at! > b.completed_at! ? -1 : byPosition(a, b)
}

/** By space, list, section ("without section" first), then position; a subtask right under its parent. */
export function byPlace(view: View): (a: Reminder, b: Reminder) => number {
  const sectionIndex = (r: Reminder) => {
    if (!r.section_id) return -1
    return view.sectionsOf(r.list_id).findIndex((s) => s.id === r.section_id)
  }
  const anchor = (r: Reminder) => (r.parent_id ? (view.reminder(r.parent_id) ?? r) : r)
  return (a, b) => {
    const pa = anchor(a)
    const pb = anchor(b)
    const space = view.spaceIndex(view.list(pa.list_id)?.space_id ?? '') - view.spaceIndex(view.list(pb.list_id)?.space_id ?? '')
    if (space) return space
    const list = view.listIndex(pa.list_id) - view.listIndex(pb.list_id)
    if (list) return list
    const section = sectionIndex(pa) - sectionIndex(pb)
    if (section) return section
    if (pa.id !== pb.id) return byPosition(pa, pb)
    if (a.id === b.id) return 0
    if (!a.parent_id) return -1
    if (!b.parent_id) return 1
    return byPosition(a, b)
  }
}

export function tileItems(view: View, tile: Tile, today: string): Reminder[] {
  switch (tile) {
    case 'today':
      return open(view)
        .filter((r) => r.due_date && r.due_date <= today)
        .sort(byDue)
    case 'scheduled':
      return open(view)
        .filter((r) => r.due_date)
        .sort(byDue)
    case 'all':
      return open(view).sort(byPlace(view))
    case 'flagged':
      return open(view)
        .filter((r) => r.flagged)
        .sort(byPlace(view))
    case 'assigned':
      return open(view)
        .filter((r) => r.assignees.includes(view.me))
        .sort(byDue)
    case 'done':
      return view.visible.filter((r) => r.completed_at).sort(byCompletion)
  }
}

export function tileCount(view: View, tile: Tile, today: string): number | null {
  return tile === 'done' ? null : tileItems(view, tile, today).length
}

/** "Scheduled" groups by day. */
export function groupByDay(items: Reminder[]): { day: string; items: Reminder[] }[] {
  const out: { day: string; items: Reminder[] }[] = []
  for (const item of items) {
    const day = item.due_date ?? ''
    const last = out.at(-1)
    if (last && last.day === day) last.items.push(item)
    else out.push({ day, items: [item] })
  }
  return out
}

// ---- Own filters ----------------------------------------------------------------------------------------------------

export const FILTER_STATES = ['open', 'completed', 'all'] as const
export type FilterState = (typeof FILTER_STATES)[number]
export const DUE_WORDS = ['overdue', 'today', 'tomorrow', 'next7', 'later', 'any', 'none'] as const
export type DueWord = (typeof DUE_WORDS)[number]
export const DONE_WORDS = ['today', 'yesterday', 'last7', 'last30', 'earlier'] as const
export type DoneWord = (typeof DONE_WORDS)[number]
export type Who = 'me' | 'nobody' | number

/** The conditions as they count: unknown keys and values passed over, an empty list as no condition. */
export interface Rules {
  state: FilterState
  due: DueWord[]
  done: DoneWord[]
  spaces: string[]
  lists: string[]
  flagged: boolean
  assignees: Who[]
  priority: number[]
  tags: string[]
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const known = <T extends string>(value: unknown, allowed: readonly T[]): T[] => listOf(value).filter((v): v is T => allowed.includes(v as T))
const fold = (text: string) => text.normalize('NFC').toLowerCase()

export function readRules(raw: unknown): Rules {
  const rules = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    state: FILTER_STATES.includes(rules.state as FilterState) ? (rules.state as FilterState) : 'open',
    due: known(rules.due, DUE_WORDS),
    done: known(rules.done, DONE_WORDS),
    spaces: listOf(rules.spaces).filter((v): v is string => typeof v === 'string'),
    lists: listOf(rules.lists).filter((v): v is string => typeof v === 'string'),
    flagged: rules.flagged === true,
    assignees: listOf(rules.assignees).filter((v): v is Who => v === 'me' || v === 'nobody' || Number.isInteger(v)),
    priority: listOf(rules.priority).filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3),
    tags: listOf(rules.tags).filter((v): v is string => typeof v === 'string'),
  }
}

/** The day of a moment in the browser's time zone, as "today" is reckoned. */
export function localDayOf(moment: string): string {
  const d = new Date(moment)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dueMatches(word: DueWord, due: string | null, today: string): boolean {
  if (word === 'none') return !due
  if (!due) return false
  switch (word) {
    case 'overdue':
      return due < today
    case 'today':
      return due === today
    case 'tomorrow':
      return due === addDays(today, 1)
    case 'next7':
      return today <= due && due <= addDays(today, 6)
    case 'later':
      return due > addDays(today, 6)
    case 'any':
      return true
  }
}

function doneMatches(word: DoneWord, day: string, today: string): boolean {
  switch (word) {
    case 'today':
      return day === today
    case 'yesterday':
      return day === addDays(today, -1)
    case 'last7':
      return addDays(today, -6) <= day && day <= today
    case 'last30':
      return addDays(today, -29) <= day && day <= today
    case 'earlier':
      return day < addDays(today, -29)
  }
}

/**
 * What an own filter finds, in the order the page shows it: the open ones as "Today" sorts, then the completed ones
 * newest first. Never the trash; subtasks count; a hidden space only when the filter names it or one of its lists.
 * `dayOf` gives the day of a completion (the browser's zone; the shared test set uses a fixed one).
 */
export function filterItems(view: View, raw: unknown, today: string, dayOf: (moment: string) => string = localDayOf): Reminder[] {
  const rules = readRules(raw)
  const named = new Set([...rules.spaces, ...rules.lists.map((id) => view.list(id)?.space_id ?? '')])
  const tags = new Set(rules.tags.map(fold))
  const open: Reminder[] = []
  const done: Reminder[] = []
  for (const r of view.live) {
    const spaceId = view.list(r.list_id)?.space_id ?? ''
    if (view.isHidden(spaceId) && !named.has(spaceId)) continue
    const completed = !!r.completed_at
    if ((rules.state === 'open' && completed) || (rules.state === 'completed' && !completed)) continue
    if (completed) {
      if (rules.done.length && !rules.done.some((word) => doneMatches(word, dayOf(r.completed_at!), today))) continue
    } else if (rules.due.length && !rules.due.some((word) => dueMatches(word, r.due_date, today))) continue
    if ((rules.spaces.length || rules.lists.length) && !rules.lists.includes(r.list_id) && !rules.spaces.includes(spaceId)) continue
    if (rules.flagged && !r.flagged) continue
    const people = r.assignees
    if (rules.assignees.length && !rules.assignees.some((who) => (who === 'me' ? people.includes(view.me) : who === 'nobody' ? !people.length : people.includes(who)))) continue
    if (rules.priority.length && !rules.priority.includes(r.priority)) continue
    if (tags.size && !r.tags.some((tag) => tags.has(fold(tag)))) continue
    if (completed) done.push(r)
    else open.push(r)
  }
  open.sort(byDue)
  done.sort(byCompletion)
  return [...open, ...done]
}

/** The number in the sidebar: the matches, only for a filter of open tasks. */
export function filterCount(view: View, raw: unknown, today: string): number | null {
  return readRules(raw).state === 'open' ? filterItems(view, raw, today).length : null
}
