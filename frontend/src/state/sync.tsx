/**
 * The sync engine for the page: one per signed-in account, started after the sign-in, stopped with it. Components
 * read the view with `useView()` (it changes with every new state) and change things through `useEngine()`.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

import { SIGNED_OUT_EVENT } from '../api/client'
import { SyncEngine, type Notice, type SyncStatus } from '../sync/engine'
import { httpTransport, type Transport } from '../sync/transport'
import type { View } from '../sync/view'

const Context = createContext<SyncEngine | null>(null)

/** How the provider makes its engine; tests hand in their own. */
export type MakeEngine = () => SyncEngine

function defaultEngine(): SyncEngine {
  return new SyncEngine({
    transport: httpTransport() as Transport,
    // Tests fetch by hand; a page keeps asking `/wait` for news.
    wait: import.meta.env.MODE !== 'test',
    onSignedOut: () => window.dispatchEvent(new Event(SIGNED_OUT_EVENT)),
  })
}

export function SyncProvider({ children, make = defaultEngine }: { children: ReactNode; make?: MakeEngine }) {
  const [engine] = useState(make)
  useEffect(() => {
    engine.start().catch(() => undefined)
    // Back in the tab or back online: send what waits and fetch what is new.
    const wake = () => {
      if (document.visibilityState === 'hidden') return
      void engine.flush()
      void engine.pull().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      engine.stop()
    }
  }, [engine])
  return <Context.Provider value={engine}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useEngine(): SyncEngine {
  const engine = useContext(Context)
  if (!engine) throw new Error('useEngine outside SyncProvider')
  return engine
}

/** The state as the page shows it; renders again on every change. */
// eslint-disable-next-line react-refresh/only-export-components
export function useView(): View {
  const engine = useEngine()
  useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => engine.version,
  )
  return engine.view()
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSyncState(): { status: SyncStatus; waiting: number; notices: Notice[]; loaded: boolean } {
  const engine = useEngine()
  useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => engine.version,
  )
  return { status: engine.status, waiting: engine.queue.length, notices: engine.notices, loaded: engine.status !== 'loading' }
}

/** Whether the server knows own filters and hidden collections (`filters` in `features`, contract 0.5); an older one
 * would refuse them. */
// eslint-disable-next-line react-refresh/only-export-components
export function useFiltersOffered(): boolean {
  const engine = useEngine()
  useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => engine.version,
  )
  return engine.me?.features.includes('filters') ?? false
}
