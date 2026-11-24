/**
 * Comments under a task (contract 0.9) and the history between them: what the web reads from `/api/reminders/{id}/history`,
 * the text of a comment cut into words, links and mentions, the `@` being typed and the line the history shows.
 */
import { api } from '../api/client'
import type { Comment } from '../sync/types'

/** How long the author may change a comment (as the server counts). */
export const EDIT_HOURS = 24
export const COMMENT_MAX = 4000

/** One thing that happened to a task (`services/history.py`): who, when, which field, before and after. */
export interface TaskEvent {
  id: number
  field: 'created' | 'completion' | 'occurrence' | 'due' | 'assignees' | 'priority' | 'list' | 'title' | string
  by: number | null
  at: string
  old: unknown
  new: unknown
}

export function loadHistory(reminderId: string): Promise<TaskEvent[]> {
  return api<{ events: TaskEvent[] }>(`/api/reminders/${reminderId}/history`).then((answer) => answer.events)
}

/** Comments and events in the order they happened. */
export type Entry = { type: 'comment'; at: string; comment: Comment } | { type: 'event'; at: string; event: TaskEvent }

export function timeline(comments: Comment[], events: TaskEvent[]): Entry[] {
  const all: Entry[] = [...comments.map((comment) => ({ type: 'comment' as const, at: comment.created_at, comment })), ...events.map((event) => ({ type: 'event' as const, at: event.at, event }))]
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.type === b.type ? 0 : a.type === 'event' ? -1 : 1))
}

/** Whether `me` may still change the text of a comment (own, not removed, younger than a day). */
export function mayEdit(comment: Comment, me: number, now: number): boolean {
  if (comment.author_id !== me || comment.removed_at) return false
  return now - Date.parse(comment.created_at) <= EDIT_HOURS * 3600_000
}

/** A piece of a comment's text as it is drawn. */
export type Piece = { kind: 'text'; text: string } | { kind: 'link'; text: string } | { kind: 'mention'; text: string; id: number }

const LINK = /\b(?:https?:\/\/|mailto:)[^\s<>"]+[^\s<>".,;:!?)\]'’”]/giu

/**
 * The text cut into plain words, links (`http`, `https`, `mailto`) and mentions: `@Name` of a person the comment
 * names, the longest name first.
 */
export function pieces(text: string, mentioned: { id: number; name: string }[]): Piece[] {
  const marks: { start: number; end: number; piece: Piece }[] = []
  for (const match of text.matchAll(LINK)) marks.push({ start: match.index!, end: match.index! + match[0].length, piece: { kind: 'link', text: match[0] } })
  const names = [...mentioned].filter((m) => m.name).sort((a, b) => b.name.length - a.name.length)
  for (const person of names) {
    const needle = `@${person.name}`
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      from = at + needle.length
      if (marks.some((m) => at < m.end && from > m.start)) continue
      marks.push({ start: at, end: from, piece: { kind: 'mention', text: needle, id: person.id } })
    }
  }
  marks.sort((a, b) => a.start - b.start)
  const out: Piece[] = []
  let at = 0
  for (const mark of marks) {
    if (mark.start > at) out.push({ kind: 'text', text: text.slice(at, mark.start) })
    out.push(mark.piece)
    at = mark.end
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

/** The `@` being typed right before the caret: where it starts and what follows it, or null. */
export function typedMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/u.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > 40 || /\n/.test(query) || /\s{2}/.test(query)) return null
  return { start: at, query }
}

/** The people a text names: those picked whose `@Name` is still in it. */
export function mentionsIn(text: string, picked: { id: number; name: string }[]): number[] {
  return [...new Set(picked.filter((p) => p.name && text.includes(`@${p.name}`)).map((p) => p.id))]
}
