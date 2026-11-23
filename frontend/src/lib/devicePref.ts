/**
 * Choices of the look that belong to this device and the account signed in on it, never to the server (the width of
 * the sidebar), as nexnotes' `lib/devicePref.ts`. Kept in `localStorage` under `nextasks.<name>.<account>`; a blocked
 * or full storage keeps the choice until the page is reloaded.
 */
import { useSyncExternalStore } from 'react'

import { useAuth } from '../state/auth'

const listeners = new Set<() => void>()
/** What was read or set in this page load, so every reader sees the same at once. */
const cache = new Map<string, string | null>()

export function prefKey(name: string, account: number): string {
  return `nextasks.${name}.${account}`
}

function read(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null
  let value: string | null
  try {
    value = localStorage.getItem(key)
  } catch {
    value = null
  }
  cache.set(key, value)
  return value
}

export function setPref(name: string, account: number, value: string | null): void {
  const key = prefKey(name, account)
  cache.set(key, value)
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Holds until the page is reloaded.
  }
  for (const listener of [...listeners]) listener()
}

/** For tests: as after a fresh page load. */
export function forgetPrefs(): void {
  cache.clear()
}

/**
 * The stored value of `name` for the account signed in, read through `parse` (which says what a missing or broken
 * value means); and how to change it (`null` goes back to the default).
 */
export function useDevicePref<T>(name: string, parse: (raw: string | null) => T): [T, (value: string | null) => void] {
  const account = useAuth().me?.id ?? 0
  const raw = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => read(prefKey(name, account)),
  )
  return [parse(raw), (value) => setPref(name, account, value)]
}
