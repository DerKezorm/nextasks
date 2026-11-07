/**
 * Completing a reminder (data model, "Regeln" and "Abhaken einer wiederholten Erinnerung"). The same steps run in the
 * web for the picture before the server answers, and in the fake server for tests.
 */
import { step } from './repeat'
import type { Clock, Data } from './types'
import { uuid5 } from './uuid'

export interface Stored {
  data: Data
  clock: Clock
}

export interface CompleteWorld {
  reminder(id: string): Stored | undefined
  /** Reminders whose `parent_id` is `id`. */
  children(id: string): Stored[]
  /** Writes a reminder (new or changed). */
  save(id: string, record: Stored): void
}

export interface CompleteOutcome {
  code: 'ok' | 'already_done' | 'due_changed'
  copy_id: string | null
  next_due: { due_date: string; due_time: string | null } | null
  /** Ids written. */
  touched: string[]
}

/** The id of the done copy of a repeated reminder's occurrence. */
export function copyId(id: string, occurrence: string): string {
  return uuid5(id, occurrence)
}

export function applyComplete(world: CompleteWorld, id: string, occurrence: string | null, at: string, on: string, by: number | null): CompleteOutcome {
  const original = world.reminder(id)
  if (!original) throw new Error('no such reminder')
  const time = Date.parse(at)
  const data = original.data
  const due = (data.due_date as string | null) ?? null
  const repeat = due ? ((data.repeat as string | null) ?? null) : null
  const touched: string[] = []

  const finish = (target: Stored, targetId: string) => {
    target.data.completed_at = at
    target.data.completed_by = by
    target.clock.completion = time
    world.save(targetId, target)
    touched.push(targetId)
  }
  const finishWithChildren = () => {
    finish(original, id)
    for (const child of world.children(id)) if (!child.data.completed_at) finish(child, child.data.id as string)
  }

  if (!repeat) {
    if (data.completed_at) return { code: 'already_done', copy_id: null, next_due: null, touched }
    finishWithChildren()
    return { code: 'ok', copy_id: null, next_due: null, touched }
  }

  const copy = occurrence ? copyId(id, occurrence) : null
  if (copy && world.reminder(copy)) return { code: 'already_done', copy_id: null, next_due: null, touched }
  if (occurrence !== due) return { code: 'due_changed', copy_id: null, next_due: null, touched }
  const outcome = step(repeat, (data.repeat_from as 'due' | 'completion') ?? 'due', due!, on)
  if (outcome.ended) {
    if (data.completed_at) return { code: 'already_done', copy_id: null, next_due: null, touched }
    finishWithChildren()
    return { code: 'ok', copy_id: null, next_due: null, touched }
  }

  // The done copy: everything of the original, but without repetition, on the day it was due, done now.
  const copyData: Data = { ...structuredClone(data), id: copy, repeat: null, repeat_from: 'due', due_date: occurrence, completed_at: at, completed_by: by, parent_id: null }
  const copyClock: Clock = {}
  for (const key of Object.keys(original.clock)) copyClock[key] = time
  world.save(copy!, { data: copyData, clock: copyClock })
  touched.push(copy!)

  // The original moves on; its subtasks open again.
  data.due_date = outcome.due
  data.repeat = outcome.repeat
  original.clock.due = time
  world.save(id, original)
  touched.push(id)
  for (const child of world.children(id)) {
    if (!child.data.completed_at) continue
    child.data.completed_at = null
    child.data.completed_by = null
    child.clock.completion = time
    world.save(child.data.id as string, child)
    touched.push(child.data.id as string)
  }
  return { code: 'ok', copy_id: copy, next_due: { due_date: outcome.due, due_time: (data.due_time as string | null) ?? null }, touched }
}
