/**
 * The look through ("Rückschau", web only): old and overdue tasks from `GET /api/sweep`, one after the other. Keeping
 * one leaves it alone for 30 days (`POST /api/sweep/keep`); deferring, parking and binning are ordinary changes.
 */
import { Hourglass } from 'lucide-react'
import { useEffect, useState } from 'react'

import { api } from '../api/client'

/** A list as the review's routes name it; `deleted` for one in the trash or gone. */
export interface ListBrief {
  id: string
  name: string | null
  color: string | null
  icon: string | null
  space_id: string | null
  deleted: boolean
}

export const SWEEP_ICON = Hourglass

export interface SweepTask {
  id: string
  title: string
  list: ListBrief
  section_id: string | null
  due_date: string | null
  due_time: string | null
  repeat: string | null
  flagged: boolean
  priority: number
  assignees: (number | null)[]
  created_at: string
  age_days: number
  unchanged_days: number
  overdue_days: number | null
  reasons: ('unchanged' | 'overdue')[]
}

export interface SweepAnswer {
  today: string
  stale_days: number
  total: number
  keep_days: number
  tasks: SweepTask[]
}

export function readSweep(limit = 200): Promise<SweepAnswer> {
  return api<SweepAnswer>('/api/sweep', { query: { limit } })
}

export function keepTask(id: string): Promise<unknown> {
  return api('/api/sweep/keep', { method: 'POST', body: { id } })
}

/** How many tasks wait for a look through; 0 while unknown or none (an older server answers 404). Read again when
 * `again` changes. */
export function useSweepCount(again: unknown = null): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    readSweep(1)
      .then((answer) => alive && setCount(answer.total))
      .catch(() => alive && setCount(0))
    return () => {
      alive = false
    }
  }, [again])
  return count
}
