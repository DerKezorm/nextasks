/**
 * The frame (docs "Aussehen", "Web"): the sidebar with logo, collections, spaces and the account; the page, which
 * carries its own head with "+ New task"; the detail of a task as a card in the middle over the blurred page
 * (`?reminder=`, a click on the task) and, switched on and off by the small button of a row, as a column on the right
 * (`?pane=`). There is no bar across the top. Keys: N new task, / or Ctrl+K search, X tick off, F mark, Enter open,
 * Esc close, ? the list of keys; with a task open only X, F and Esc.
 */
import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { useEngine, useSyncState, useView } from '../state/sync'
import { UpdateBanner } from './AppInstall'
import { ContextMenuProvider } from './ContextMenu'
import { DetailPane, NewTaskDetail, type NewTarget } from './DetailPane'
import { Dialog } from './Dialog'
import { MembersDialog } from './MembersDialog'
import { BackToOverview } from './PageHead'
import { ShellContext, type Shell } from './Shell'
import { Sidebar } from './Sidebar'
import { ListDialog, SpaceDialog } from './ThingDialogs'
import { WhatsNewBanner } from './WhatsNew'

/** Pages without a head of their own: on a phone they get the way back to the overview above them. */
const PLAIN = ['/settings', '/account', '/about', '/trash']

type Open = { kind: 'list'; list: string | null; space?: string } | { kind: 'space'; space: string | null } | { kind: 'members'; space: string } | { kind: 'keys' } | null

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function AppShell() {
  const { t } = useTranslation()
  const view = useView()
  const engine = useEngine()
  const sync = useSyncState()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [dialog, setDialog] = useState<Open>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const quick = useRef<(() => void) | null>(null)
  const pageTarget = useRef<NewTarget | null>(null)
  const [newTarget, setNewTarget] = useState<NewTarget | null>(null)
  const opened = params.get('reminder')
  const pane = params.get('pane')

  const showPopup = useCallback(
    (id: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p)
        next.set('reminder', id)
        return next
      }),
    [setParams],
  )
  // With the side column shown, a task opens there; otherwise in the card in the middle.
  const openReminder = useCallback(
    (id: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p)
        if (next.get('pane')) {
          next.set('pane', id)
          next.delete('reminder')
        } else next.set('reminder', id)
        return next
      }),
    [setParams],
  )
  const closeReminder = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p)
      next.delete('reminder')
      return next
    })
    // Back to the row it came from, so the keys go on there.
    if (opened) setTimeout(() => [...document.querySelectorAll<HTMLElement>('[data-reminder]')].find((row) => row.dataset.reminder === opened)?.focus(), 0)
  }, [setParams, opened])
  const togglePane = useCallback(
    (id: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p)
        if (next.get('pane') === id) next.delete('pane')
        else next.set('pane', id)
        return next
      }),
    [setParams],
  )
  const closePane = useCallback(
    () =>
      setParams((p) => {
        const next = new URLSearchParams(p)
        next.delete('pane')
        return next
      }),
    [setParams],
  )
  const shell: Shell = useMemo(
    () => ({
      selected: opened ?? pane ?? selected,
      pane,
      openReminder,
      showPopup,
      closeReminder,
      togglePane,
      closePane,
      select: setSelected,
      focusQuick: () => quick.current?.(),
      registerQuick: (focus) => {
        quick.current = focus
      },
      newTask: (target) => {
        setNewTarget(target ?? pageTarget.current)
        openReminder('new')
      },
      registerTarget: (target) => {
        pageTarget.current = target
      },
      openSearch: () => navigate('/search'),
      openKeys: () => setDialog({ kind: 'keys' }),
      newList: (space) => setDialog({ kind: 'list', list: null, space }),
      newSpace: () => setDialog({ kind: 'space', space: null }),
      editList: (list) => setDialog({ kind: 'list', list }),
      editSpace: (space) => setDialog({ kind: 'space', space }),
      members: (space) => setDialog({ kind: 'members', space }),
    }),
    [opened, pane, selected, openReminder, showPopup, closeReminder, togglePane, closePane, navigate],
  )

  // A link from a program (`link` of `/api/v1`: `/lists/<list>?task=<id>`) opens the task as a click does: in the side
  // column while it is shown, otherwise in the card in the middle. The address then says it the page's own way.
  const asked = params.get('task')
  useEffect(() => {
    if (!asked) return
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        next.delete('task')
        if (next.get('pane')) next.set('pane', asked)
        else next.set('reminder', asked)
        return next
      },
      { replace: true },
    )
  }, [asked, setParams])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        navigate('/search')
        return
      }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || dialog) return
      const shown = opened ?? pane
      if (shown && !['escape', 'x', 'f'].includes(e.key.toLowerCase())) return
      if (e.key === '/') {
        e.preventDefault()
        navigate('/search')
      } else if (e.key.toLowerCase() === 'n' && e.shiftKey) {
        // Shift+N: the quick entry of the page, or the one of Today where the page has none.
        e.preventDefault()
        if (quick.current) quick.current()
        else {
          navigate('/today')
          setTimeout(() => quick.current?.(), 0)
        }
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        shell.newTask()
      } else if (e.key === '?') setDialog({ kind: 'keys' })
      else if (e.key === 'Escape' && opened) closeReminder()
      else if (e.key === 'Escape' && pane) closePane()
      else if (shown && (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'f')) {
        // With a task open and no row in focus, the keys act on it.
        const reminder = view.reminder(shown)
        if (!reminder) return
        if (e.key.toLowerCase() === 'x') engine.toggle(shown)
        else engine.put('reminder', shown, { flagged: !reminder.flagged })
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [navigate, dialog, opened, pane, closeReminder, closePane, engine, view, shell])

  // Notices fade after a while.
  useEffect(() => {
    if (!sync.notices.length) return
    const timer = setTimeout(() => engine.dismiss(sync.notices[0].id), 7000)
    return () => clearTimeout(timer)
  }, [sync.notices, engine])

  const reminder = opened && opened !== 'new' ? view.reminder(opened) : undefined
  const paneReminder = pane && pane !== 'new' ? view.reminder(pane) : undefined
  // A new task goes to the list "+ New task" named, else the page's, else the first of "Private" (never into a space
  // one hid: then the first list of the first space shown).
  const first = view.defaultList
  const target = newTarget ?? pageTarget.current ?? (first ? { spot: { list_id: first.id, section_id: null, parent_id: null }, defaults: {} } : null)

  return (
    <ShellContext.Provider value={shell}>
      <ContextMenuProvider>
      <div className="nt-safe flex h-dvh overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <UpdateBanner />
          <WhatsNewBanner />
          {sync.status === 'failed' && (
            <p role="alert" className="border-b border-bad-500/30 bg-bad-500/10 px-4 py-2 text-sm text-bad-500">
              {t('sync.serverOld')}
            </p>
          )}
          {PLAIN.includes(location.pathname) && (
            <div className="shrink-0 border-b border-ink-700 bg-ink-900 px-4 pt-3 pb-1 md:hidden">
              <BackToOverview />
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <Outlet />
            {paneReminder && <DetailPane key={'pane-' + paneReminder.id} reminder={paneReminder} mode="pane" />}
            {pane === 'new' && target && <NewTaskDetail key="pane-new" target={target} mode="pane" />}
            {reminder && <DetailPane key={reminder.id} reminder={reminder} mode="popup" />}
            {opened === 'new' && target && <NewTaskDetail key="new" target={target} mode="popup" />}
          </div>
        </div>
      </div>
      {dialog?.kind === 'list' && <ListDialog listId={dialog.list} spaceId={dialog.space} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'space' && <SpaceDialog spaceId={dialog.space} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'members' && <MembersDialog spaceId={dialog.space} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'keys' && <KeysDialog onClose={() => setDialog(null)} />}
      {sync.notices.length > 0 && (
        <div className="nt-safe-bottom pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6" aria-live="polite">
          {sync.notices.slice(-3).map((notice) => (
            <div key={notice.id} role="status" data-testid="notice" className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-mist-200 shadow-2xl shadow-black/40">
              <span className="min-w-0 flex-1">{t(`notice.${notice.code}`, { defaultValue: t('notice.invalid'), ...notice.values })}</span>
              <button type="button" onClick={() => engine.dismiss(notice.id)} aria-label={t('common.close')} className="-m-1 rounded-full p-1 hover:bg-ink-800">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      </ContextMenuProvider>
    </ShellContext.Provider>
  )
}

function KeysDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const keys: [string, string][] = [
    ['N', t('keys.new')],
    [`${t('keys.shift')} N`, t('keys.quick')],
    ['/', t('keys.search')],
    [`${t('keys.ctrl')} K`, t('keys.search')],
    ['↑ ↓', t('keys.move')],
    ['Enter', t('keys.open')],
    ['X', t('keys.complete')],
    ['F', t('keys.flag')],
    ['Entf', t('keys.delete')],
    ['Esc', t('keys.close')],
  ]
  return (
    <Dialog title={t('keys.title')} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {keys.map(([key, text]) => (
          <div key={key + text} className="contents">
            <dt>
              <kbd>{key === 'Entf' ? t('keys.del') : key}</kbd>
            </dt>
            <dd className="text-mist-300">{text}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}
