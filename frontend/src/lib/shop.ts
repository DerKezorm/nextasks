/**
 * Shopping help for any list ("Oft gekauft", web only): what was done often in the list and is not open now, from
 * `GET /api/lists/{id}/suggestions`, and where a new task without a section of its own goes: into the section its
 * title stood in last. Titles are compared by the same key as the server's (without a count at the start, "2 Gurken"
 * is "gurken").
 */
import { useEffect, useState } from 'react'

import { api } from '../api/client'
import type { SyncEngine } from '../sync/engine'
import type { Data, Reminder, Section } from '../sync/types'
import type { View } from '../sync/view'
import { createReminder, moveReminder, siblingsAt, type Spot } from './actions'
import { showNotice } from './notice'

export interface Suggestion {
  title: string
  key: string
  count: number
  last: string
  last_days_ago: number
  interval_days: number | null
  expected: string | null
  section_id: string | null
  section_name: string | null
}

export interface Suggestions {
  list_id: string
  suggestions: Suggestion[]
  sections: { id: string; name: string }[]
  placement: Record<string, string>
}

/** A count at the start of a title, with a unit: "2 ", "2x ", "1,5 l ", "500 g " (as the server's). */
const QUANTITY = /^\d+(?:[.,]\d+)?\s*(?:x|×|stk\.?|stück|pck\.?|pkg\.?|g|kg|ml|l)?\s+/i

function clean(title: string): string {
  return title.normalize('NFC').split(/\s+/).filter(Boolean).join(' ')
}

/** The count at the start of a title ("2 ", "500 g ") or ''. */
export function quantityOf(title: string): string {
  const text = clean(title)
  const found = QUANTITY.exec(text)
  return found && found[0].length < text.length ? found[0] : ''
}

/** The title without a count at its start, as people wrote it otherwise. */
export function plainTitle(title: string): string {
  const text = clean(title)
  return text.slice(quantityOf(text).length) || text
}

/** What two titles are compared by: without a count at the start, blanks folded, lower case ("Straße" → "strasse"). */
export function titleKey(title: string): string {
  return plainTitle(title).toLowerCase().replaceAll('ß', 'ss')
}

/**
 * The section a new task titled `title` goes into: where a task of that title stands open in the list now, else where
 * one was done last (as the page knows it), else what the server knows; only sections the list still has.
 */
export function placeFor(title: string, listId: string, reminders: Reminder[], sections: Section[], placement: Record<string, string> = {}): Section | null {
  const key = titleKey(title)
  if (!key) return null
  const known = new Map(sections.map((s) => [s.id, s]))
  const same = reminders.filter((r) => r.list_id === listId && !r.parent_id && r.section_id && known.has(r.section_id) && titleKey(r.title) === key)
  const open = same.find((r) => !r.completed_at)
  if (open) return known.get(open.section_id!)!
  const done = same.filter((r) => r.completed_at).sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1))[0]
  if (done) return known.get(done.section_id!)!
  const server = placement[key]
  return server ? (known.get(server) ?? null) : null
}

/** Suggestions that start with (or contain) what is typed, those that start with it first. */
export function matching(suggestions: Suggestion[], typed: string, most = 5): Suggestion[] {
  const key = titleKey(typed)
  if (key.length < 2) return []
  const starts = suggestions.filter((s) => s.key.startsWith(key) && s.key !== key)
  const inside = suggestions.filter((s) => !s.key.startsWith(key) && s.key.includes(key))
  return [...starts, ...inside].slice(0, most)
}

/** The suggestions of a list, read again when `again` changes (a task done or added); null while there are none to
 * show (an older server, the list not reachable). */
export function useSuggestions(listId: string, again: unknown): Suggestions | null {
  const [found, setFound] = useState<Suggestions | null>(null)
  const [read, setRead] = useState<{ listId: string; again: unknown } | null>(null)
  useEffect(() => {
    let alive = true
    // The first time at once; after a change a moment later, when the server has it too.
    const timer = setTimeout(
      () => {
        api<Suggestions>(`/api/lists/${encodeURIComponent(listId)}/suggestions`, { query: { limit: 12 } })
          .then((answer) => alive && setFound(answer))
          .catch(() => alive && setFound(null))
        setRead({ listId, again })
      },
      read?.listId === listId ? 1500 : 0,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // `read` only says whether this list was read before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, again])
  return found?.list_id === listId ? found : null
}

/**
 * Makes a task at the end of the list, in `section` when one is given; then says so at the bottom ("Sorted into
 * Chilled"), with "Undo" that takes it out of the section again.
 */
export function addSorted(engine: SyncEngine, view: View, listId: string, fields: Data, section: Section | null, say: (section: string) => string): string {
  const loose: Spot = { list_id: listId, section_id: null, parent_id: null }
  const id = createReminder(engine, view, section ? { ...loose, section_id: section.id } : loose, fields)
  if (section)
    showNotice({
      text: say(section.name),
      undo: () => {
        const now = engine.view()
        if (now.reminder(id)) moveReminder(engine, now, id, loose, siblingsAt(now, loose, id).length)
      },
    })
  return id
}
