/**
 * "Someday" (web only): the open tasks without a date, from every space shown, by space and list as "All" shows
 * them. It needs no field of its own: a task waits there as long as it has no date ("Someday" in a task's menu takes
 * the date away), so the app sees the same tasks in its lists. Whether the sidebar shows it is a choice of this device
 * (`lib/devicePref.ts`), not of the account: the collections the app knows keep their `tile_pref`.
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

/** Open, without a date, outside the trash and hidden spaces; subtasks only where they have no date either. */
export function somedayItems(view: View): Reminder[] {
  return view.visible.filter((r) => !r.completed_at && !r.due_date).sort(byPlace(view))
}

/** Whether "Someday" shows in the sidebar on this device, and how to change it. */
export function useSomedayShown(): [boolean, (shown: boolean) => void] {
  const [shown, set] = useDevicePref('someday.hidden', (raw) => raw !== 'hidden')
  return [shown, (next) => set(next ? null : 'hidden')]
}

/** "Someday" for one task: its date goes (and with it a repetition); the notice brings both back for ten seconds. */
export function parkReminder(engine: SyncEngine, reminder: Reminder, say: (title: string) => string): void {
  if (!reminder.due_date) return
  const before = { due_date: reminder.due_date, due_time: reminder.due_time, repeat: reminder.repeat, repeat_from: reminder.repeat_from }
  engine.put('reminder', reminder.id, dueChange(reminder, null, null))
  showNotice({ text: say(reminder.title), undo: () => engine.put('reminder', reminder.id, before) })
}
