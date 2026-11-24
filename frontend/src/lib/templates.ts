/**
 * Lists made from something: a start template for a new list (shopping with its sections, a packing list, a weekly
 * clean with a repeating task per room), a copy of a list (its sections and tasks, all open, with or without their
 * dates), and "all open again" for lists one ticks off again and again. Everything goes the normal way (`put`), so the
 * app and every other device see it as any list.
 */
import type { SyncEngine } from '../sync/engine'
import { copyId } from '../sync/complete'
import { byPosition, keysBetween } from '../sync/position'
import { addDays, weekdayOf } from '../sync/repeat'
import type { Data, Reminder } from '../sync/types'
import { uuid4 } from '../sync/uuid'
import type { View } from '../sync/view'
import { showNotice } from './notice'

export const TEMPLATE_KINDS = ['empty', 'shopping', 'packing', 'cleaning'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

interface TemplateSection {
  /** The section's name: `templates.sections.<key>`. */
  key: string
  /** Its tasks: `templates.items.<key>`. */
  items: string[]
  /** For a weekly clean: the day of the week its tasks come back on, 0 = Monday. */
  weekday?: number
}

export interface Template {
  color: string
  icon: string
  sections: TemplateSection[]
}

export const TEMPLATES: Record<Exclude<TemplateKind, 'empty'>, Template> = {
  shopping: {
    color: 'green',
    icon: 'cart',
    sections: [
      { key: 'produce', items: [] },
      { key: 'chilled', items: [] },
      { key: 'bread', items: [] },
      { key: 'drugstore', items: [] },
      { key: 'household', items: [] },
    ],
  },
  packing: {
    color: 'pink',
    icon: 'suitcase',
    sections: [
      { key: 'clothes', items: ['shirts', 'trousers', 'underwear', 'socks', 'pyjamas', 'jacket'] },
      { key: 'bathroom', items: ['toothbrush', 'toothpaste', 'shampoo', 'deodorant', 'sunCream'] },
      { key: 'tech', items: ['phoneCharger', 'headphones', 'powerBank', 'adapter'] },
      { key: 'papers', items: ['passport', 'tickets', 'healthCard', 'wallet'] },
    ],
  },
  cleaning: {
    color: 'teal',
    icon: 'cleaning',
    sections: [
      { key: 'kitchen', items: ['wipeSurfaces', 'cleanHob', 'emptyBins'], weekday: 0 },
      { key: 'bathroom', items: ['cleanSink', 'cleanShower', 'changeTowels'], weekday: 2 },
      { key: 'living', items: ['dust', 'vacuum'], weekday: 4 },
      { key: 'bedroom', items: ['changeSheets', 'vacuum'], weekday: 5 },
    ],
  },
}

type T = (key: string, values?: Record<string, unknown>) => string

/** The next day (today included) that is the given weekday, 0 = Monday. */
export function nextWeekday(today: string, weekday: number): string {
  return addDays(today, (weekday - weekdayOf(today) + 7) % 7)
}

/** Puts a template's sections and tasks into a (new) list. */
export function fillList(engine: SyncEngine, listId: string, kind: TemplateKind, t: T, today: string): void {
  if (kind === 'empty') return
  const template = TEMPLATES[kind]
  const sectionKeys = keysBetween(null, null, template.sections.length)
  template.sections.forEach((section, index) => {
    const sectionId = uuid4()
    engine.put('section', sectionId, { list_id: listId, name: t(`templates.sections.${section.key}`), position: sectionKeys[index] })
    const keys = section.items.length ? keysBetween(null, null, section.items.length) : []
    section.items.forEach((item, at) => {
      const fields: Data = { list_id: listId, section_id: sectionId, parent_id: null, position: keys[at], title: t(`templates.items.${item}`) }
      if (section.weekday !== undefined) {
        fields.due_date = nextWeekday(today, section.weekday)
        fields.due_time = null
        fields.repeat = `FREQ=WEEKLY;BYDAY=${WEEKDAYS[section.weekday]}`
        fields.repeat_from = 'due'
      }
      engine.put('reminder', uuid4(), fields)
    })
  })
}

/** Whether a done task is the kept copy of one occurrence of a repeating task (history, not a task of its own). */
function isRepeatCopy(reminder: Reminder, all: Reminder[]): boolean {
  if (!reminder.completed_at || !reminder.due_date) return false
  return all.some((other) => other.id !== reminder.id && !!other.repeat && copyId(other.id, reminder.due_date!) === reminder.id)
}

/**
 * A copy of a list in a space: its name, look and sections, its tasks and subtasks in their order, all open. With
 * `keepDates` the dates and repetitions go along; people it was assigned to only within the same space.
 */
export function copyList(engine: SyncEngine, view: View, sourceId: string, options: { name: string; spaceId: string; keepDates: boolean; position: string }): string | null {
  const source = view.list(sourceId)
  if (!source) return null
  const id = uuid4()
  engine.put('list', id, { space_id: options.spaceId, name: options.name, color: source.color, icon: source.icon, view: source.view, position: options.position })
  const sections = new Map<string, string>()
  for (const section of view.sectionsOf(sourceId)) {
    const sectionId = uuid4()
    sections.set(section.id, sectionId)
    engine.put('section', sectionId, { list_id: id, name: section.name, position: section.position })
  }
  const all = view.live.filter((r) => r.list_id === sourceId)
  const taken = all.filter((r) => !isRepeatCopy(r, all))
  const sameSpace = options.spaceId === source.space_id
  const made = new Map<string, string>()
  const copy = (r: Reminder, parent: string | null) => {
    const copyIdNew = uuid4()
    made.set(r.id, copyIdNew)
    const fields: Data = {
      list_id: id,
      section_id: parent ? null : r.section_id ? (sections.get(r.section_id) ?? null) : null,
      parent_id: parent,
      position: r.position,
      title: r.title,
      notes: r.notes,
      url: r.url,
      flagged: r.flagged,
      priority: r.priority,
      tags: r.tags,
      location: r.location,
    }
    if (options.keepDates && r.due_date) {
      fields.due_date = r.due_date
      fields.due_time = r.due_time
      fields.repeat = r.repeat
      fields.repeat_from = r.repeat_from
    }
    if (sameSpace && r.assignees.length) fields.assignees = r.assignees
    engine.put('reminder', copyIdNew, fields)
  }
  const tops = taken.filter((r) => !r.parent_id).sort(byPosition)
  for (const r of tops) copy(r, null)
  for (const r of taken.filter((r) => r.parent_id).sort(byPosition)) {
    const parent = made.get(r.parent_id!)
    if (parent) copy(r, parent)
  }
  return id
}

/** The done tasks of a list that "All open again" opens (not the kept copies of repeating ones). */
export function doneToReopen(view: View, listId: string): Reminder[] {
  const all = view.live.filter((r) => r.list_id === listId)
  return all.filter((r) => r.completed_at && !isRepeatCopy(r, all))
}

/** Opens every done task of a list again; the notice says how many, with "Undo" that ticks them off again. */
export function reopenAll(engine: SyncEngine, view: View, listId: string, say: (count: number) => string): number {
  const done = doneToReopen(view, listId)
  for (const r of done) engine.put('reminder', r.id, { completed_at: null, completed_by: null })
  // Ticking a task off ticks its open subtasks off too: each only while it is still open.
  const again = () => done.forEach((r) => !engine.view().reminder(r.id)?.completed_at && engine.toggle(r.id))
  if (done.length) showNotice({ text: say(done.length), undo: again })
  return done.length
}
