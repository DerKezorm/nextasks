/**
 * Taking turns ("Reihum", field `rotation`, contract 0.9; the server's `services/rotation.py`). A repeating task in a
 * shared space goes round the people of its rotation; `assignees` holds whose turn it is. Whoever ticks it off had
 * the turn and the one after them is in charge of what comes next; someone outside the rotation moves it one step
 * on. The server does the same for every way a task is ticked off; here it is only the picture before it answers.
 */
import type { Reminder } from './types'

type Turned = Pick<Reminder, 'rotation' | 'assignees' | 'repeat' | 'due_date'>

/** Whether turns are taken: a rotation on a repeating task (in "Private" the server keeps none). */
export function takesTurns(reminder: Turned): boolean {
  return (reminder.rotation?.length ?? 0) > 0 && !!reminder.repeat && !!reminder.due_date
}

/** Whose turn it is: the first of `assignees` in the rotation, else the first of the rotation. */
export function whoseTurn(rotation: number[], assignees: number[]): number {
  return assignees.find((id) => rotation.includes(id)) ?? rotation[0]
}

/** The one after `person` in the rotation, round again after the last. */
export function nextAfter(rotation: number[], person: number): number {
  return rotation[(rotation.indexOf(person) + 1) % rotation.length]
}

/** In charge after a completion that made a copy. */
export function afterCompletion(rotation: number[], assignees: number[], by: number | null): number {
  if (by !== null && rotation.includes(by)) return nextAfter(rotation, by)
  return nextAfter(rotation, whoseTurn(rotation, assignees))
}

/** Whose turn it is and who comes after, while turns are taken. */
export function turnOf(reminder: Turned): { now: number; then: number | null } | null {
  if (!takesTurns(reminder)) return null
  const now = whoseTurn(reminder.rotation, reminder.assignees)
  const then = reminder.rotation.length > 1 ? nextAfter(reminder.rotation, now) : null
  return { now, then }
}

/**
 * `assignees` after picking `id` in a menu: taking turns, it becomes their turn (only people of the rotation are
 * offered); else the person is added or taken away.
 */
export function pickAssignee(reminder: Turned, id: number): number[] {
  if (takesTurns(reminder)) return reminder.rotation.includes(id) ? [id] : reminder.assignees
  return reminder.assignees.includes(id) ? reminder.assignees.filter((x) => x !== id) : [...reminder.assignees, id]
}

/** Who a menu offers to assign: taking turns, the people of the rotation in their order. */
export function offered<T extends { account_id: number }>(reminder: Turned, members: T[]): T[] {
  if (!takesTurns(reminder)) return members
  return reminder.rotation.flatMap((id) => members.filter((m) => m.account_id === id))
}
