/**
 * Who is signed in. `loading` until the server answered, `setup` while nextasks has no account yet, `signedOut`,
 * or `signedIn` with the account. A request that finds the session gone sends `SIGNED_OUT_EVENT`; then `ended` is set, so
 * the sign-in can say why (blocked, signed out everywhere, E2 of the night check).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { ApiError, authApi, SIGNED_OUT_EVENT, type Me } from '../api/client'
import i18n, { changeLanguage } from '../i18n'

/** `offline`: the server did not answer (no network, or it is down); asked again until it does. */
type Status = 'loading' | 'setup' | 'signedOut' | 'signedIn' | 'offline'

type Auth = {
  status: Status
  me: Me | null
  /** The session ended while the app was open (not by signing out here). */
  ended: boolean
  refresh: () => Promise<void>
  setMe: (me: Me) => void
  signOut: () => Promise<void>
}

const Context = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMeState] = useState<Me | null>(null)
  const [ended, setEnded] = useState(false)

  const setMe = useCallback((next: Me) => {
    setMeState(next)
    setEnded(false)
    setStatus('signedIn')
    // The account's language wins over the browser's.
    if (next.language && next.language !== i18n.language) void changeLanguage(next.language)
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
      setEnded(true)
      setStatus('signedOut')
      setMeState(null)
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
    setStatus('signedOut')
  }, [])

  const value = useMemo(() => ({ status, me, ended, refresh, setMe, signOut }), [status, me, ended, refresh, setMe, signOut])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): Auth {
  const value = useContext(Context)
  if (!value) throw new Error('useAuth outside AuthProvider')
  return value
}

/** Only addresses inside nextasks, so a link cannot send someone elsewhere after signing in. */
// eslint-disable-next-line react-refresh/only-export-components
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}
