/**
 * "Someday" (web only): the open tasks without a date, from every space shown, by space and list as "All" shows
 * them. It needs no field of its own: a task waits there as long as it has no date ("Someday" in a task's menu takes
 * the date away), so the app sees the same tasks in its lists. Lists one ticks off as a whole (groceries, packing)
 * have no dates either: each can be left out of "Someday" on this device, so it keeps to what was put off. Whether
 * the sidebar shows it, and which lists it leaves out, are choices of this device (`lib/devicePref.ts`), not of the
 * account: the collections the app knows keep their `tile_pref`.
 */
import { CalendarOff } from 'lucide-react'

import type { SyncEngine } from '../sync/engine'
import { byPlace } from '../sync/tiles'
import type { Reminder } from '../sync/types'
import type { View } from '../sync/view'
import { dueChange } from './actions'
import { useDevicePref } from './devicePref'
import { showNotice } from './notice'

export const SOMEDAY_ICON = CalendarOff

/** Open, without a date, outside the trash, hidden spaces and the lists left out; subtasks only where they have no
 * date either. */
export function somedayItems(view: View, leftOut: string[] = []): Reminder[] {
  return view.visible.filter((r) => !r.completed_at && !r.due_date && !leftOut.includes(r.list_id)).sort(byPlace(view))
}

/** The lists "Someday" leaves out on this device, and how to leave one out or take it in again. */
export function useSomedayLists(): [string[], (listId: string, leftOut: boolean) => void] {
  const [ids, set] = useDevicePref('someday-lists', (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  })
  return [
    ids,
    (listId, leftOut) => {
      const next = leftOut ? [...new Set([...ids, listId])] : ids.filter((id) => id !== listId)
      set(next.length ? JSON.stringify(next) : null)
    },
  ]
}

/** Whether "Someday" shows in the sidebar on this device, and how to change it. */
export function useSomedayShown(): [boolean, (shown: boolean) => void] {
  const [shown, set] = useDevicePref('someday-hidden', (raw) => raw !== 'hidden')
  return [shown, (next) => set(next ? null : 'hidden')]
}

/** "Someday" for one task: its date goes (and with it a repetition); the notice brings both back for ten seconds. */
export function parkReminder(engine: SyncEngine, reminder: Reminder, say: (title: string) => string): void {
  if (!reminder.due_date) return
  const before = { due_date: reminder.due_date, due_time: reminder.due_time, repeat: reminder.repeat, repeat_from: reminder.repeat_from }
  engine.put('reminder', reminder.id, dueChange(reminder, null, null))
  showNotice({ text: say(reminder.title), undo: () => engine.put('reminder', reminder.id, before) })
}
