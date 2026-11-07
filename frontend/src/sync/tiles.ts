/**
 * The tiles at the top of the sidebar (data model, "Kacheln"). They count open reminders outside the trash, subtasks
 * included; "Done" has no number. Spaces one hid (`space_pref`) do not count.
 */
import { byPosition } from './position'
import type { Reminder } from './types'
import type { View } from './view'

export const TILES = ['today', 'scheduled', 'all', 'flagged', 'assigned', 'done'] as const
export type Tile = (typeof TILES)[number]

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
      return view.visible
        .filter((r) => r.completed_at)
        .sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : a.completed_at! > b.completed_at! ? -1 : byPosition(a, b)))
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
