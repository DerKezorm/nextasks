import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { SidebarBody } from './components/Sidebar'
import { AboutPage } from './pages/AboutPage'
import { AccountPage } from './pages/AccountPage'
import { AppConnectPage, ConfirmEmailPage, InvitePage, LoginPage, SetupPage, UnsubscribePage } from './pages/AuthPages'
import { FilterPage } from './pages/FilterPage'
import { ListPage } from './pages/ListPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { TilePage } from './pages/TilePage'
import { TrashPage } from './pages/TrashPage'
import { OfflinePage } from './components/AppInstall'
import { useAuth } from './state/auth'
import { SyncProvider, useSyncState, useView } from './state/sync'
import { shownTiles, TILES } from './sync/tiles'

/** Everything behind the sign-in: without an account the page goes to the sign-in, and comes back after. An account
 * that still has to set up its second factor (the operator requires one) reaches its own account page only. */
function SignedIn({ children }: { children: ReactNode }) {
  const { status, me, ended, refresh } = useAuth()
  const location = useLocation()
  if (status === 'loading') return null
  if (status === 'offline') return <OfflinePage retry={() => void refresh()} />
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}${ended ? '&ended=1' : ''}`} replace />
  if (me?.second_factor_setup_required && location.pathname !== '/account') return <Navigate to="/account?tab=security" replace />
  return <SyncProvider key={me?.id}>{children}</SyncProvider>
}

const PHONE = '(max-width: 767px)'

/** Whether the window is as narrow as a phone's, followed as it changes. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE)
    const change = () => setPhone(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return phone
}

/**
 * `/`: Today; on a phone the overview, the sidebar as a page of its own (docs "Aussehen", "Web"). `/?space=<id>`
 * (after joining a space): its first list once the space is there.
 */
function Home() {
  const [params] = useSearchParams()
  const view = useView()
  const sync = useSyncState()
  const phone = usePhone()
  const { t } = useTranslation()
  const space = params.get('space')
  if (!space && phone)
    return (
      <main className="nc-scroll min-w-0 flex-1 overflow-y-auto bg-ink-900" aria-label={t('overview.title')}>
        <SidebarBody />
      </main>
    )
  if (!sync.loaded) return <main className="flex-1" />
  if (!space) return <Navigate to={startPath(view)} replace />
  const first = view.listsOf(space)[0]
  return <Navigate to={first ? `/lists/${first.id}` : '/today'} replace />
}

/** Where the start page leads: the first tile still shown, else the first own filter shown, else the first list. */
function startPath(view: ReturnType<typeof useView>): string {
  const tile = shownTiles(view)[0]
  if (tile) return `/${tile}`
  const filter = view.shownFilters[0]
  if (filter) return `/filters/${filter.id}`
  const list = view.defaultList
  return list ? `/lists/${list.id}` : '/today'
}

export default function App() {
  return (
    <Routes>
      <Route path="setup" element={<SetupPage />} />
      <Route path="login" element={<LoginPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="confirm-email/:token" element={<ConfirmEmailPage />} />
      <Route path="unsubscribe/:token" element={<UnsubscribePage />} />
      <Route
        path="app-connect"
        element={
          <SignedIn>
            <AppConnectPage />
          </SignedIn>
        }
      />
      <Route
        element={
          <SignedIn>
            <AppShell />
          </SignedIn>
        }
      >
        <Route index element={<Home />} />
        {TILES.map((tile) => (
          <Route key={tile} path={tile} element={<TilePage tile={tile} />} />
        ))}
        <Route path="lists/:id" element={<ListPage />} />
        <Route path="filters/:id" element={<FilterPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Route>
    </Routes>
  )
}
