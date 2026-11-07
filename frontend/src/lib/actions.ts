/**
 * What the page does with the things: make, move, sort, clear. Each step is a `put` (or `delete`, `complete`,
 * `position`) through the engine; the order keys come from `fractional-indexing`.
 */
import type { SyncEngine } from '../sync/engine'
import { byPosition, keyAtEnd, keyAtStart, keysBetween, placeAt } from '../sync/position'
import type { Data, Reminder } from '../sync/types'
import { uuid4 } from '../sync/uuid'
import type { View } from '../sync/view'
import { plainNotes } from './notes'

export interface Spot {
  list_id: string
  section_id: string | null
  parent_id: string | null
}

/** The reminders that share a place (same list and section, or the same parent), in order. */
export function siblingsAt(view: View, spot: Spot, without?: string): Reminder[] {
  return view.reminders
    .filter((r) => r.id !== without && !view.inTrash(r) && r.list_id === spot.list_id && (spot.parent_id ? r.parent_id === spot.parent_id : !r.parent_id && r.section_id === spot.section_id))
    .sort(byPosition)
}

export function createReminder(engine: SyncEngine, view: View, spot: Spot, fields: Data, atStart = false): string {
  const id = uuid4()
  const siblings = siblingsAt(view, spot)
  const position = atStart ? keyAtStart(siblings) : keyAtEnd(siblings)
  engine.put('reminder', id, { ...fields, list_id: spot.list_id, section_id: spot.parent_id ? null : spot.section_id, parent_id: spot.parent_id, position })
  return id
}

/** Puts a reminder at `index` among the reminders of `spot` (its subtasks go along to another list). */
export function moveReminder(engine: SyncEngine, view: View, id: string, spot: Spot, index: number): void {
  const reminder = view.reminder(id)
  if (!reminder) return
  const siblings = siblingsAt(view, spot, id)
  const { key, moved } = placeAt(siblings, Math.max(0, Math.min(index, siblings.length)))
  for (const m of moved) engine.put('reminder', m.id, { position: m.position })
  engine.put('reminder', id, { list_id: spot.list_id, section_id: spot.parent_id ? null : spot.section_id, parent_id: spot.parent_id, position: key })
  if (reminder.list_id !== spot.list_id) for (const child of view.childrenOf(id)) engine.put('reminder', child.id, { list_id: spot.list_id, section_id: null })
}

export function createSpace(engine: SyncEngine, view: View, name: string, color: string, icon: string): string {
  const id = uuid4()
  engine.put('space', id, { name, color, icon })
  // At the end of the own sidebar, once the order was ever set.
  const own = view.spaces.map((s) => view.membersOf(s.id).find((m) => m.account_id === view.me)?.position ?? null)
  if (own.some(Boolean)) engine.setSpacePosition(id, keyAtEnd(own.map((position) => ({ position }))))
  return id
}

export function createList(engine: SyncEngine, view: View, spaceId: string, name: string, color: string, icon: string): string {
  const id = uuid4()
  engine.put('list', id, { space_id: spaceId, name, color, icon, view: 'list', position: keyAtEnd(view.listsOf(spaceId)) })
  return id
}

export function createSection(engine: SyncEngine, view: View, listId: string, name: string): string {
  const id = uuid4()
  engine.put('section', id, { list_id: listId, name, position: keyAtEnd(view.sectionsOf(listId)) })
  return id
}

/** A list to `index` within a space (maybe another one). */
export function moveList(engine: SyncEngine, view: View, listId: string, spaceId: string, index: number): void {
  const siblings = view.listsOf(spaceId).filter((l) => l.id !== listId)
  const { key, moved } = placeAt(siblings, Math.max(0, Math.min(index, siblings.length)))
  for (const m of moved) engine.put('list', m.id, { position: m.position })
  const list = view.list(listId)
  engine.put('list', listId, list?.space_id === spaceId ? { position: key } : { space_id: spaceId, position: key })
}

export function moveSection(engine: SyncEngine, view: View, sectionId: string, index: number): void {
  const section = view.section(sectionId)
  if (!section) return
  const siblings = view.sectionsOf(section.list_id).filter((s) => s.id !== sectionId)
  const { key, moved } = placeAt(siblings, Math.max(0, Math.min(index, siblings.length)))
  for (const m of moved) engine.put('section', m.id, { position: m.position })
  engine.put('section', sectionId, { position: key })
}

/** The own order of the spaces: every space gets a key, so the order holds as dragged. */
export function moveSpace(engine: SyncEngine, view: View, spaceId: string, index: number): void {
  const order = view.spaces.map((s) => s.id).filter((id) => id !== spaceId)
  order.splice(Math.max(0, Math.min(index, order.length)), 0, spaceId)
  const current = (id: string) => view.membersOf(id).find((m) => m.account_id === view.me)?.position ?? null
  const keys = keysBetween(null, null, order.length)
  order.forEach((id, i) => {
    if (current(id) !== keys[i]) engine.setSpacePosition(id, keys[i])
  })
}

/** "Delete completed" of a list: every done reminder into the trash, each on its own. */
export function clearCompleted(engine: SyncEngine, view: View, listId: string): number {
  const done = view.live.filter((r) => r.list_id === listId && r.completed_at)
  for (const r of done) engine.trash('reminder', r.id)
  return done.length
}

export function setPref(engine: SyncEngine, listId: string, change: { show_completed?: boolean; notify_changes?: boolean }): void {
  engine.put('list_pref', listId, change)
}

/** Hides a space for oneself (everywhere one signs in), or shows it again. */
export function setSpaceHidden(engine: SyncEngine, spaceId: string, hidden: boolean): void {
  engine.put('space_pref', spaceId, { hidden })
}

/** Searching: title, the note as plain text, tags and link, every word must occur; hidden spaces stay out. */
export function search(view: View, query: string, withDone: boolean): Reminder[] {
  const words = query.toLowerCase().normalize('NFC').split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return view.visible
    .filter((r) => withDone || !r.completed_at)
    .filter((r) => {
      const text = [r.title, plainNotes(r.notes), r.url ?? '', ...r.tags.map((t) => '#' + t)].join(' ').toLowerCase().normalize('NFC')
      return words.every((w) => text.includes(w))
    })
}
