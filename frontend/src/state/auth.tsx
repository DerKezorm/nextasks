/**
 * Who is signed in. `loading` until the server answered, `setup` while nextasks has no account yet, `signedOut`,
 * or `signedIn` with the account.
 *
 * A session that ends while the page is open does not throw the page away: `interrupted` is set, and the dialog
 * "Session expired" (`components/SessionDialog.tsx`, the shared account module's `sessionExpiredParts`) asks to sign in
 * again right there; what waits to be sent stays in the queue of the sync engine, and after signing in again `session`
 * counts up, so the engine starts over (`state/sync.tsx`) and sends it; the page and what is typed on it stay. Ended before anything was on
 * screen, the page goes to the sign-in with `ended` set, so the sign-in can say why (blocked, signed out everywhere,
 * E2 of the night check).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { ApiError, authApi, SIGNED_OUT_EVENT, type Me } from '../api/client'
import i18n, { changeLanguage } from '../i18n'
import { applyMode, storedRaw, type Mode } from '../lib/theme'

/** `offline`: the server did not answer (no network, or it is down); asked again until it does. */
type Status = 'loading' | 'setup' | 'signedOut' | 'signedIn' | 'offline'

type Auth = {
  status: Status
  me: Me | null
  /** The session ended while the app was open (not by signing out here). */
  ended: boolean
  /** The session ended while a page was open; the dialog "Session expired" stands over it. */
  interrupted: boolean
  /** Counts the sign-ins again in that dialog: the sync engine starts over after each. */
  session: number
  refresh: () => Promise<void>
  setMe: (me: Me) => void
  signOut: () => Promise<void>
  /** Signed in again in the dialog: the page goes on where it was. */
  resume: (me: Me) => void
  /** Out of the dialog to the sign-in page (somebody else signs in, or the account is blocked). */
  leave: () => void
}

const Context = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMeState] = useState<Me | null>(null)
  const [ended, setEnded] = useState(false)
  const [interrupted, setInterrupted] = useState(false)
  const [session, setSession] = useState(0)

  const setMe = useCallback((next: Me) => {
    setMeState(next)
    setEnded(false)
    setInterrupted(false)
    setStatus('signedIn')
    // The account's language wins over the browser's.
    if (next.language && next.language !== i18n.language) void changeLanguage(next.language)
    // Light, dark or as the device says, for the account on every device (konten 1.1.0). An account that has chosen
    // nothing yet takes this browser's choice of before once.
    if (next.theme === 'light' || next.theme === 'dark' || next.theme === 'system') applyMode(next.theme as Mode)
    else if (next.theme === '') void authApi.adoptTheme(storedRaw()).then((taken) => applyMode(taken.theme as Mode), () => undefined)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const state = await authApi.setupState()
      if (state.needs_setup) {
        setStatus('setup')
        return
      }
      if (!state.signed_in) {
        setStatus('signedOut')
        setMeState(null)
        return
      }
      setMe(await authApi.me())
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setStatus('signedOut')
        setMeState(null)
      } else {
        // The server is not reachable (the installed app started without network): no sign-in for that, the page
        // says so and asks again (below).
        setStatus('offline')
      }
    }
  }, [setMe])

  useEffect(() => {
    void refresh()
    const gone = () => {
      setStatus((now) => {
        // Signed in a moment ago: keep the page and ask to sign in again over it.
        if (now === 'signedIn') {
          setInterrupted(true)
          return now
        }
        setEnded(true)
        setMeState(null)
        return 'signedOut'
      })
    }
    window.addEventListener(SIGNED_OUT_EVENT, gone)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, gone)
  }, [refresh])

  // Without the server: ask again every few seconds, and at once when the network is back.
  useEffect(() => {
    if (status !== 'offline') return
    const again = () => void refresh()
    const timer = setInterval(again, 5000)
    window.addEventListener('online', again)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', again)
    }
  }, [status, refresh])

  const signOut = useCallback(async () => {
    await authApi.logout().catch(() => undefined)
    setMeState(null)
    setInterrupted(false)
    setStatus('signedOut')
  }, [])

  const resume = useCallback(
    (next: Me) => {
      setMe(next)
      setSession((count) => count + 1)
    },
    [setMe],
  )

  const leave = useCallback(() => {
    setInterrupted(false)
    setEnded(true)
    setMeState(null)
    setStatus('signedOut')
  }, [])

  const value = useMemo(
    () => ({ status, me, ended, interrupted, session, refresh, setMe, signOut, resume, leave }),
    [status, me, ended, interrupted, session, refresh, setMe, signOut, resume, leave],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): Auth {
  const value = useContext(Context)
  if (!value) throw new Error('useAuth outside AuthProvider')
  return value
}

/** How often the account signed in again in the dialog "Session expired"; 0 outside the provider (tests). */
// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): number {
  return useContext(Context)?.session ?? 0
}

/** Only addresses inside nextasks, so a link cannot send someone elsewhere after signing in. */
// eslint-disable-next-line react-refresh/only-export-components
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}
