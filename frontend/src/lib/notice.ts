/**
 * The notice at the bottom of the page, as nexnotes': one at a time, five seconds, or ten with "Undo". A new notice
 * takes the place of the old. The frame draws it (`components/NoticeHost.tsx`); the sync's own notices come in here
 * as well.
 */
import { useSyncExternalStore } from 'react'

/** How long "Undo" stays. */
export const UNDO_MS = 10_000
/** How long a notice without "Undo" stays. */
export const NOTICE_MS = 5_000

export type Notice = { text: string; undo?: () => void }

let notice: (Notice & { key: number }) | null = null
let counter = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function publish(next: typeof notice): void {
  notice = next
  for (const listener of listeners) listener()
}

export function hideNotice(): void {
  if (timer) clearTimeout(timer)
  timer = null
  publish(null)
}

/** Shows a notice; with `undo`, the button "Undo" until the time is up. */
export function showNotice(next: Notice, ms = next.undo ? UNDO_MS : NOTICE_MS): void {
  if (timer) clearTimeout(timer)
  counter += 1
  publish({ ...next, key: counter })
  timer = setTimeout(hideNotice, ms)
}

export function useNotice() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => notice,
  )
}
