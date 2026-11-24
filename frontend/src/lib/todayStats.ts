/**
 * The numbers of the right column of "Today" from the server's review (`GET /api/stats`): the run of days, today per
 * person, the last days for "Your week". Read again a moment after the day changed on the page (a task ticked off,
 * moved, made), so the column follows without asking on every keystroke. Without an answer the column shows what the
 * page knows itself.
 */
import { useEffect, useState } from 'react'

import { api } from '../api/client'

export interface TodayPerson {
  id: number | null
  done: number
  due: number
  due_done: number
}

/** The parts of `/api/stats` this page reads. */
export interface TodayStats {
  scope: { alone: boolean; today: string }
  people: { id: number | null; name: string; me: boolean; former: boolean }[]
  heatmap: { from: string; to: string; days: number[] }
  streak: { current: number; done_today: boolean; record: number }
  today: { date: string; done: number; due: number; due_done: number; open: number; overdue: number; people: TodayPerson[] }
}

/** How long the page waits after a change before it asks again. */
export const STATS_WAIT_MS = 1200

export function useTodayStats(signature: string): TodayStats | null {
  const [stats, setStats] = useState<TodayStats | null>(null)
  useEffect(() => {
    let alive = true
    const timer = setTimeout(
      () => {
        api<TodayStats>('/api/stats')
          .then((answer) => alive && setStats(answer))
          .catch(() => undefined)
      },
      stats ? STATS_WAIT_MS : 0,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // Asked again only when the day on the page changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return stats
}

/** The last seven days (today last) of the heatmap: done per day. */
export function lastWeek(stats: TodayStats): number[] {
  return stats.heatmap.days.slice(-7)
}
