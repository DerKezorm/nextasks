/**
 * The things of nextasks as they travel over `/api/app/1` (`docs/datenmodell.md`, `docs/vertrag-block1.md` in
 * nextasks-ios). Field names stay English and as the server writes them.
 */

export type Kind = 'space' | 'member' | 'list' | 'section' | 'reminder' | 'attachment' | 'list_pref' | 'space_pref'

/** When each field or field group last changed, ms UTC. */
export type Clock = Record<string, number>
export type Data = Record<string, unknown>

/** One entry of `/changes`, of `current` and of `copy`. */
export interface Item {
  kind: Kind
  id: string
  cursor: number
  deleted: boolean
  data: Data | null
  clock: Clock | null
}

export interface Person {
  id: number
  /** null: the account was deleted, or shares no space with this one any more ("Former member"). */
  name: string | null
  avatar_hash: string | null
}

export interface ChangesAnswer {
  cursor: number
  more: boolean
  space_ids: string[]
  people: Person[]
  items: Item[]
}

export const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray'] as const
export type ColorName = (typeof COLORS)[number]

export interface Space {
  id: string
  name: string
  color: string
  icon: string
  private: boolean
  deleted_at: string | null
  /** The own role, without a clock. */
  role: 'manager' | 'member'
}

export interface Member {
  id: string
  space_id: string
  account_id: number
  role: 'manager' | 'member'
  /** Only on the own entry: where the space stands in the own sidebar. */
  position: string | null
}

export interface List {
  id: string
  space_id: string
  name: string
  color: string
  icon: string
  view: 'list' | 'columns'
  position: string
  deleted_at: string | null
}

export interface Section {
  id: string
  list_id: string
  name: string
  position: string
}

export interface Place {
  name: string
  lat: number
  lon: number
  radius_m: number
  on: 'arrive' | 'leave'
}

export interface Reminder {
  id: string
  list_id: string
  section_id: string | null
  parent_id: string | null
  position: string
  title: string
  notes: string
  url: string | null
  due_date: string | null
  due_time: string | null
  repeat: string | null
  repeat_from: 'due' | 'completion'
  location: Place | null
  flagged: boolean
  priority: number
  tags: string[]
  assignees: number[]
  completed_at: string | null
  completed_by: number | null
  created_by: number | null
  created_at: string
  deleted_at: string | null
}

export interface Attachment {
  id: string
  reminder_id: string
  name: string
  mime: string
  size: number
  hash: string
  created_by: number | null
  created_at: string
}

export interface ListPref {
  id: string
  show_completed: boolean
  notify_changes: boolean
}

/** One person's own setting for a space (contract 0.3): hidden in the sidebar, the collections and the search. */
export interface SpacePref {
  id: string
  hidden: boolean
}

export interface KindTypes {
  space: Space
  member: Member
  list: List
  section: Section
  reminder: Reminder
  attachment: Attachment
  list_pref: ListPref
  space_pref: SpacePref
}

// ---- Operations -----------------------------------------------------------------------------------------------------

export interface PutOp {
  op_id: string
  type: 'put'
  kind: Exclude<Kind, 'member' | 'attachment'>
  id: string
  fields: Data
  clock: Clock
}

export interface DeleteOp {
  op_id: string
  type: 'delete'
  kind: 'section' | 'attachment'
  id: string
}

export interface CompleteOp {
  op_id: string
  type: 'complete'
  id: string
  occurrence: string | null
  at: string
  on: string
}

export interface PositionOp {
  op_id: string
  type: 'position'
  space_id: string
  position: string | null
}

export type Op = PutOp | DeleteOp | CompleteOp | PositionOp

export interface Result {
  op_id: string
  ok: boolean
  code?: string
  current: Item | null
  copy?: Item | null
  applied?: string[]
  ignored?: string[]
  dropped_assignees?: number[]
  copy_id?: string | null
  next_due?: { due_date: string; due_time: string | null } | null
}

export interface Me {
  version: string
  /** The server's time, ms UTC (an ISO text is read too). */
  now: number | string
  account: { id: number; name: string; username: string; operator: boolean; timezone: string; language: string; avatar_hash: string | null }
  device: { id: string; name: string } | null
  features: string[]
  limits: { attachment_bytes: number }
}
