/**
 * Which fields each kind has, which belong together under one clock, and what a new record starts with
 * (data model, "Uhren und Abgleich" and "Standardwerte beim Anlegen").
 */
import type { Clock, Data, Kind } from './types'

/** Clock key → the fields it covers. A field without a group is its own key. */
export const GROUPS: Partial<Record<Kind, Record<string, string[]>>> = {
  space: { name: ['name'], color: ['color'], icon: ['icon'], deleted_at: ['deleted_at'] },
  list: { space_id: ['space_id'], name: ['name'], color: ['color'], icon: ['icon'], view: ['view'], position: ['position'], deleted_at: ['deleted_at'] },
  section: { list_id: ['list_id'], name: ['name'], position: ['position'] },
  reminder: {
    place: ['list_id', 'section_id', 'parent_id', 'position'],
    title: ['title'],
    notes: ['notes'],
    url: ['url'],
    due: ['due_date', 'due_time', 'repeat', 'repeat_from'],
    location: ['location'],
    flagged: ['flagged'],
    priority: ['priority'],
    tags: ['tags'],
    assignees: ['assignees'],
    completion: ['completed_at', 'completed_by'],
    deleted_at: ['deleted_at'],
  },
  list_pref: { show_completed: ['show_completed'], notify_changes: ['notify_changes'] },
  space_pref: { hidden: ['hidden'] },
}

/** The clock key a field is kept under; null for fields without a clock (`id`, `private`, `created_by`, …). */
export function keyOf(kind: Kind, field: string): string | null {
  const groups = GROUPS[kind]
  if (!groups) return null
  for (const [key, fields] of Object.entries(groups)) if (fields.includes(field)) return key
  return null
}

export function fieldsOf(kind: Kind, key: string): string[] {
  return GROUPS[kind]?.[key] ?? [key]
}

/** The value a clock key stands for: the field itself, or for a group the object of its fields. */
export function valueOf(kind: Kind, key: string, data: Data): unknown {
  const fields = fieldsOf(kind, key)
  if (fields.length === 1 && fields[0] === key) return data[key] ?? null
  const value: Data = {}
  for (const field of fields) value[field] = data[field] ?? null
  return value
}

export const DEFAULTS: Record<Kind, Data> = {
  space: { name: '', color: 'blue', icon: 'list', private: false, deleted_at: null },
  member: {},
  list: { space_id: null, name: '', color: 'blue', icon: 'list', view: 'list', position: '', deleted_at: null },
  section: { list_id: null, name: '', position: '' },
  reminder: {
    list_id: null,
    section_id: null,
    parent_id: null,
    position: '',
    title: '',
    notes: '',
    url: null,
    due_date: null,
    due_time: null,
    repeat: null,
    repeat_from: 'due',
    location: null,
    flagged: false,
    priority: 0,
    tags: [],
    assignees: [],
    completed_at: null,
    completed_by: null,
    created_by: null,
    created_at: '',
    deleted_at: null,
  },
  attachment: {},
  list_pref: { show_completed: false, notify_changes: false },
  space_pref: { hidden: false },
}

/** Fields a `put` must carry when it creates the record. */
export const REQUIRED: Partial<Record<Kind, string[]>> = {
  space: ['name'],
  list: ['space_id', 'name', 'position'],
  section: ['list_id', 'name', 'position'],
  reminder: ['list_id', 'title', 'position'],
  list_pref: [],
  space_pref: [],
}

/** Fields only the server sets: a `put` may carry them, the server ignores them. */
export const SERVER_ONLY = ['created_by', 'completed_by', 'private', 'role']

/** A new record with the defaults, every clock 0 so any real change wins. */
export function fresh(kind: Kind, id: string): { data: Data; clock: Clock } {
  const data: Data = { id, ...structuredClone(DEFAULTS[kind]) }
  const clock: Clock = {}
  for (const key of Object.keys(GROUPS[kind] ?? {})) clock[key] = 0
  return { data, clock }
}

/** The text rule: NFC, no space at either end. */
export function cleanText(value: string): string {
  return value.normalize('NFC').trim()
}

/** Length in Unicode code points. */
export function textLength(value: string): number {
  return [...value].length
}

/** Tags as stored: without `#`, without white space, 1 to 50 code points, the first of equal ones (NFC, lower). */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = cleanText(raw.replace(/^#+/, ''))
    if (!tag || /\p{White_Space}/u.test(tag) || tag.includes('#') || textLength(tag) > 50) continue
    const key = tag.normalize('NFC').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length === 20) break
  }
  return out
}
