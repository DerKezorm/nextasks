/**
 * The focus of the day: up to three tasks one picked for today, kept per account and day on the server
 * (`GET/PUT /api/focus`, web only). The page "Today" holds it and hands it down: the star among a row's buttons and
 * the entry of the context menu show only there. A change shows at once and goes to the server behind it; when the
 * server refuses, the last state it gave comes back.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { api } from '../api/client'

/** The most tasks in focus. */
export const FOCUS_MOST = 3

type Answer = { date: string; ids: string[]; most?: number }

export interface Focus {
  ids: string[]
  /** Whether the server keeps a focus at all (an older one answers 404). */
  ready: boolean
  has(id: string): boolean
  full: boolean
  /** `at`: the place in the order (at the end without). */
  add(id: string, at?: number): void
  remove(id: string): void
  toggle(id: string): void
  /** Puts a task of the focus at another place of the order (dragged, or Alt and the arrows). */
  move(id: string, to: number): void
}

const FocusContext = createContext<Focus | null>(null)

/** The focus where the page offers it ("Today"), else null. */
// eslint-disable-next-line react-refresh/only-export-components
export function useFocusOffered(): Focus | null {
  return useContext(FocusContext)
}

export function FocusProvider({ value, children }: { value: Focus; children: ReactNode }) {
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>
}

/** The own focus of today: read once, written on every change. `today` changing (past midnight) reads it again. */
// eslint-disable-next-line react-refresh/only-export-components
export function useFocusState(today: string): Focus {
  const [ids, setIds] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const kept = useRef<string[]>([])

  useEffect(() => {
    let alive = true
    api<Answer>('/api/focus')
      .then((answer) => {
        if (!alive) return
        kept.current = answer.ids
        setIds(answer.ids)
        setReady(true)
      })
      .catch(() => alive && setReady(false))
    return () => {
      alive = false
    }
  }, [today])

  const write = useCallback((next: string[]) => {
    setIds(next)
    api<Answer>('/api/focus', { method: 'PUT', body: { ids: next } })
      .then((answer) => {
        kept.current = answer.ids
        setIds(answer.ids)
      })
      .catch(() => setIds(kept.current))
  }, [])

  return useMemo(() => {
    const has = (id: string) => ids.includes(id)
    const full = ids.length >= FOCUS_MOST
    const add = (id: string, at = ids.length) => {
      if (!has(id) && !full) write([...ids.slice(0, at), id, ...ids.slice(at)])
    }
    const remove = (id: string) => {
      if (has(id)) write(ids.filter((x) => x !== id))
    }
    const move = (id: string, to: number) => {
      const from = ids.indexOf(id)
      if (from < 0 || to < 0 || to >= ids.length || from === to) return
      const next = ids.filter((x) => x !== id)
      next.splice(to, 0, id)
      write(next)
    }
    return { ids, ready, has, full, add, remove, move, toggle: (id: string) => (has(id) ? remove(id) : add(id)) }
  }, [ids, ready, write])
}
