/**
 * Completing a reminder (data model, "Regeln" and "Abhaken einer wiederholten Erinnerung"). The same steps run in the
 * web for the picture before the server answers, and in the fake server for tests.
 */
import { step } from './repeat'
import { afterCompletion } from './rotation'
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

  if (data.completed_at) return { code: 'already_done', copy_id: null, next_due: null, touched }
  const copy = occurrence ? copyId(id, occurrence) : null
  const there = !!copy && !!world.reminder(copy)
  // Another device checked this occurrence off and the original moved on: done already.
  if (there && occurrence !== due) return { code: 'already_done', copy_id: null, next_due: null, touched }
  if (occurrence !== due) return { code: 'due_changed', copy_id: null, next_due: null, touched }
  const outcome = step(repeat, (data.repeat_from as 'due' | 'completion') ?? 'due', due!, on)
  if (outcome.ended) {
    finishWithChildren()
    return { code: 'ok', copy_id: null, next_due: null, touched }
  }

  // The done copy: everything of the original, but without repetition, on the day it was due, done now. Is it there
  // already while the original stands on its occurrence again (set back by hand), only the original moves on.
  if (!there) {
    const copyData: Data = { ...structuredClone(data), id: copy, repeat: null, repeat_from: 'due', due_date: occurrence, completed_at: at, completed_by: by, parent_id: null }
    const copyClock: Clock = {}
    for (const key of Object.keys(original.clock)) copyClock[key] = time
    world.save(copy!, { data: copyData, clock: copyClock })
    touched.push(copy!)
  }

  // The original moves on; its subtasks open again. Taking turns, the next one is in charge of it; a copy there
  // already moved the turn on when it was made.
  data.due_date = outcome.due
  data.repeat = outcome.repeat
  original.clock.due = time
  const rotation = (data.rotation as number[] | undefined) ?? []
  if (!there && rotation.length) {
    data.assignees = [afterCompletion(rotation, (data.assignees as number[]) ?? [], by)]
    original.clock.assignees = Math.max(time, (original.clock.assignees ?? 0) + 1)
  }
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
