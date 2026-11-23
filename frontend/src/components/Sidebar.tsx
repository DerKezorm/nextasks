/**
 * The left column (docs "Aussehen", "Web"): logo and word mark; the collections as rows (Today, Scheduled, All,
 * Marked, Assigned to me, Done) with a petrol symbol and their number, those one hid left out; the own filters under
 * "Filters", each with its plaque and, for open tasks, its number; one block per space with a small head (its
 * symbol, its name in capitals, the members of a shared one) and its lists, each a row with its plaque. Lists and
 * spaces are sorted by dragging; a task dropped on a list moves there. Spaces one hid wait folded under "Hidden spaces
 * (n)" to be shown again. At the bottom: new list, new space, new filter, the trash, how the sync stands. As in nexnotes,
 * "+ New task" and the search stand under the logo, the account with the way to the settings at the foot (on the chosen
 * ground while the settings are open), and the column is as wide as one drags it (`ColumnHandle`, `lib/columns.ts`).
 * On a phone the same is a page of its own, without the handle.
 */
import { ChevronDown, ChevronRight, CloudOff, Eye, EyeOff, FolderPlus, FunnelPlus, ListPlus, MoreHorizontal, Pencil, Plus, Search, Settings, Trash2, Users } from 'lucide-react'
import { createElement, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useLocation } from 'react-router-dom'

import { moveList, moveReminder, moveSpace, setSpaceHidden, siblingsAt } from '../lib/actions'
import { useColumnWidth } from '../lib/columns'
import { localDay } from '../lib/due'
import { dragging, draggedReminder, DRAG_LIST, DRAG_SPACE } from '../lib/drag'
import { iconFor } from '../lib/look'
import { TILE_LOOK } from '../lib/tileLook'
import { useAuth } from '../state/auth'
import { useEngine, useFiltersOffered, useSyncState, useView } from '../state/sync'
import { filterCount, shownTiles, tileCount } from '../sync/tiles'
import type { Filter, List, Space } from '../sync/types'
import { Avatar } from './Avatar'
import { Badge } from './Badge'
import { ColumnHandle } from './ColumnHandle'
import { Logo } from './Logo'
import { useFilterMenu, useHideSpace, useListMenu, useSpaceMenu } from './Menus'
import { AvatarStack } from './People'
import { Popover } from './Popover'
import { useShell } from './Shell'

/** A row of the sidebar; the chosen one on a light petrol ground with petrol text. */
const row = (active: boolean) =>
  'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-sm transition-colors ' + (active ? 'bg-chosen font-semibold text-accent-400' : 'text-mist-100 hover:bg-ink-800')

export function Sidebar() {
  const { t } = useTranslation()
  const [width] = useColumnWidth('sidebar')
  return (
    <div className="relative hidden shrink-0 md:flex">
      <aside style={{ width }} className="flex flex-col overflow-hidden border-r border-ink-700 bg-ink-900" aria-label={t('sidebar.label')} data-testid="sidebar">
        <SidebarBody />
      </aside>
      <ColumnHandle column="sidebar" />
    </div>
  )
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

export function SidebarBody() {
  const { t } = useTranslation()
  const view = useView()
  const sync = useSyncState()
  const shell = useShell()
  const filtersOffered = useFiltersOffered()
  const today = localDay()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2.5 pt-3">
        <Link to="/today" className="mb-3 flex items-center gap-2.5 self-start rounded-lg px-1.5 py-1" aria-label={t('app.home')}>
          <Logo className="h-7 w-7" />
          <span className="text-lg font-bold tracking-tight text-mist-100">
            NEX<span className="text-accent-500">TASKS</span>
          </span>
        </Link>
      </div>
      <div className="nc-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-2.5 pb-2" data-testid="sidebar-places">
        {/* "+ New task" and the search, as nexnotes' "+ New note" and its field "Search". */}
        <div className="flex flex-col gap-1 pb-2">
          <button type="button" className="nt-btn nt-btn-accent w-full" onClick={() => shell.newTask()} title={`${t('keys.new')} (N)`} data-testid="new-reminder">
            <Plus className="h-4 w-4" strokeWidth={2.4} aria-hidden />
            {t('reminder.new')}
          </button>
        </div>
        <NavLink
          to="/search"
          data-testid="sidebar-search"
          aria-keyshortcuts={isMac() ? 'Meta+K /' : 'Control+K /'}
          className={({ isActive }) =>
            'mb-2 flex h-9 items-center gap-2 rounded-[9px] border px-2.5 text-[13.5px] ' +
            (isActive ? 'border-accent-500 text-accent-400' : 'border-ink-700 text-mist-500 hover:bg-ink-800 hover:text-mist-100')
          }
        >
          <Search className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
          <span className="flex-1">{t('search.field')}</span>
          <kbd className="hidden md:inline" data-testid="search-key">
            {isMac() ? '⌘ K' : t('search.key')}
          </kbd>
        </NavLink>

        <nav aria-label={t('tiles.label')} className="space-y-px">
          {shownTiles(view).map((tile) => {
            const count = sync.loaded ? tileCount(view, tile, today) : null
            return (
              <NavLink key={tile} to={`/${tile}`} data-testid={`tile-${tile}`} className={({ isActive }) => row(isActive)}>
                {createElement(TILE_LOOK[tile].icon, { className: 'h-[18px] w-[18px] shrink-0 text-accent-400', strokeWidth: 2, 'aria-hidden': true })}
                <span className="min-w-0 flex-1 truncate">{t(`tiles.${tile}`)}</span>
                {count ? (
                  <span className="text-[12.5px] font-normal text-mist-600 tabular-nums" data-testid={`tile-count-${tile}`}>
                    {count}
                  </span>
                ) : null}
              </NavLink>
            )
          })}
        </nav>

        {filtersOffered && view.shownFilters.length > 0 && <Filters />}

        <div className="mt-2" data-testid="spaces">
          {view.shownSpaces.map((space) => (
            <SpaceBlock key={space.id} space={space} index={view.spaces.indexOf(space)} />
          ))}
        </div>
        {view.hiddenSpaces.length > 0 && <HiddenSpaces />}

        <div className="mt-auto space-y-px pt-4">
          <button type="button" onClick={() => shell.newList()} className={row(false) + ' w-full text-left'}>
            <ListPlus className="h-[18px] w-[18px] text-mist-500" aria-hidden /> {t('sidebar.newList')}
          </button>
          <button type="button" onClick={() => shell.newSpace()} className={row(false) + ' w-full text-left'}>
            <FolderPlus className="h-[18px] w-[18px] text-mist-500" aria-hidden /> {t('sidebar.newSpace')}
          </button>
          {filtersOffered && (
            <button type="button" onClick={() => shell.newFilter()} className={row(false) + ' w-full text-left'} data-testid="new-filter">
              <FunnelPlus className="h-[18px] w-[18px] text-mist-500" aria-hidden /> {t('filter.new')}
            </button>
          )}
          <NavLink to="/trash" className={({ isActive }) => row(isActive)}>
            <Trash2 className="h-[18px] w-[18px] text-mist-500" aria-hidden /> {t('trash.title')}
          </NavLink>
          <SyncLine />
        </div>
      </div>
      <AccountLine />
    </div>
  )
}

/** The foot of the sidebar, as nexnotes': the account, and the way to the settings, on the chosen ground while they are open. */
function AccountLine() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const shown = me?.display_name || me?.name || ''
  const person = me ? { id: me.id, name: me.name, display_name: me.display_name, avatar: me.avatar } : { id: 0, name: '', avatar: null }
  return (
    <div className="border-t border-ink-700 p-2">
      <NavLink
        to="/settings"
        data-testid="sidebar-account"
        className={({ isActive }) => 'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm transition-colors ' + (isActive ? 'nt-chosen' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100')}
      >
        <Avatar person={person} className="h-7 w-7 text-xs" />
        <span className="min-w-0 flex-1 truncate" title={`${shown} · ${t('settings.title')}`}>
          {shown} · {t('settings.title')}
        </span>
        <Settings className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
      </NavLink>
    </div>
  )
}

/** The own filters shown, in their order, under a small head like a space's. */
function Filters() {
  const { t } = useTranslation()
  const view = useView()
  const [open, setOpen] = useState(true)
  return (
    <section aria-label={t('filter.section')} className="mt-4" data-testid="filters">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group/filters flex w-full min-w-0 items-center gap-2 px-1.5 py-1 text-left text-[11.5px] font-bold tracking-[0.06em] text-mist-500 uppercase hover:text-mist-100">
        <span className="truncate">{t('filter.section')}</span>
        {open ? <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover/filters:opacity-100" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
      </button>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {view.shownFilters.map((filter) => (
            <FilterRow key={filter.id} filter={filter} />
          ))}
        </ul>
      )}
    </section>
  )
}

function FilterRow({ filter }: { filter: Filter }) {
  const view = useView()
  const sync = useSyncState()
  const menu = useFilterMenu(filter)
  const count = sync.loaded ? filterCount(view, filter.rules, localDay()) : null
  return (
    <li {...menu}>
      <NavLink to={`/filters/${filter.id}`} data-testid={`filter-${filter.name}`} className={({ isActive }) => row(isActive) + ' py-[5px]'}>
        <Badge color={filter.color} icon={filter.icon} size="sm" />
        <span className="min-w-0 flex-1 truncate">{filter.name}</span>
        {count ? (
          <span className="text-[12.5px] font-normal text-mist-600 tabular-nums" data-testid={`filter-count-${filter.name}`}>
            {count}
          </span>
        ) : null}
      </NavLink>
    </li>
  )
}

function SyncLine() {
  const { t } = useTranslation()
  const sync = useSyncState()
  if (sync.status === 'ready' && !sync.waiting) return null
  const text =
    sync.status === 'offline'
      ? t('sync.offline', { count: sync.waiting })
      : sync.status === 'failed'
        ? t('sync.failed')
        : sync.status === 'loading'
          ? t('sync.loading')
          : t('sync.waiting', { count: sync.waiting })
  return (
    <p className="flex items-center gap-2 px-2.5 pt-1 text-xs text-mist-500" role="status" data-testid="sync-line">
      {sync.status === 'offline' && <CloudOff className="h-3.5 w-3.5" aria-hidden />} {text}
    </p>
  )
}

const takesList = (event: DragEvent) => !!event.dataTransfer?.types?.includes(DRAG_LIST) || !!dragging.list
const takesSpace = (event: DragEvent) => !!event.dataTransfer?.types?.includes(DRAG_SPACE) || !!dragging.space

function SpaceBlock({ space, index }: { space: Space; index: number }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [open, setOpen] = useState(true)
  const [over, setOver] = useState(false)
  const lists = view.listsOf(space.id)
  const manager = space.role === 'manager'
  const shared = space.private ? [] : view.membersOf(space.id).map((m) => m.account_id)
  const menu = useSpaceMenu(space)
  const hide = useHideSpace()

  return (
    <section aria-label={space.name} data-space={space.id} className="mt-4">
      <div
        className={'group/space flex items-center gap-1 rounded-lg pr-0.5 ' + (over ? 'bg-accent-500/10' : '')}
        {...menu}
        draggable
        onDragStart={(event) => {
          dragging.space = space.id
          event.dataTransfer.setData(DRAG_SPACE, space.id)
        }}
        onDragEnd={() => (dragging.space = null)}
        onDragOver={(event) => {
          if (takesSpace(event) || takesList(event)) {
            event.preventDefault()
            setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          setOver(false)
          const spaceId = event.dataTransfer?.getData(DRAG_SPACE) || dragging.space
          const listId = event.dataTransfer?.getData(DRAG_LIST) || dragging.list
          event.preventDefault()
          if (spaceId && spaceId !== space.id) moveSpace(engine, view, spaceId, index)
          else if (listId) moveList(engine, view, listId, space.id, lists.length)
        }}
      >
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left text-[11.5px] font-bold tracking-[0.06em] text-mist-500 uppercase hover:text-mist-100">
          {createElement(iconFor(space.icon), { className: 'h-4 w-4 shrink-0', strokeWidth: 2, 'aria-hidden': true })}
          <span className="truncate">{space.name}</span>
          {open ? <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover/space:opacity-100" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
        </button>
        {shared.length > 1 && <AvatarStack ids={shared} people={view.people} max={4} />}
        <Popover label={t('space.menu', { name: space.name })} button={<MoreHorizontal className="h-4 w-4" />} className="rounded-md p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100">
          {(close) => (
            <>
              <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), shell.newList(space.id))}>
                <ListPlus className="h-4 w-4" aria-hidden /> {t('sidebar.newList')}
              </button>
              {manager && (
                <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), shell.editSpace(space.id))}>
                  <Pencil className="h-4 w-4" aria-hidden /> {t('space.edit')}
                </button>
              )}
              {!space.private && (
                <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), shell.members(space.id))}>
                  <Users className="h-4 w-4" aria-hidden /> {t('members.title')}
                </button>
              )}
              <button type="button" className="nc-menu-item" role="menuitem" data-testid="hide-space" onClick={() => (close(), hide(space.id))}>
                <EyeOff className="h-4 w-4" aria-hidden /> {t('space.hide')}
              </button>
            </>
          )}
        </Popover>
      </div>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {lists.map((list, i) => (
            <ListRow key={list.id} list={list} index={i} />
          ))}
          {lists.length === 0 && (
            <li>
              <button type="button" className="px-3 py-1.5 text-xs text-mist-600 hover:text-mist-300" onClick={() => shell.newList(space.id)}>
                {t('sidebar.noLists')}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/** The spaces one hid, folded at the bottom of the spaces: each with its symbol and a button to show it again. */
function HiddenSpaces() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const [open, setOpen] = useState(false)
  return (
    <section className="mt-4" aria-label={t('space.hiddenSpaces', { count: view.hiddenSpaces.length })} data-testid="hidden-spaces">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-1.5 py-1 text-left text-xs font-semibold text-mist-500 hover:text-mist-100">
        <EyeOff className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('space.hiddenSpaces', { count: view.hiddenSpaces.length })}</span>
        {open ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
      </button>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {view.hiddenSpaces.map((space) => (
            <li key={space.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-[5px] text-sm text-mist-300">
              {createElement(iconFor(space.icon), { className: 'h-4 w-4 shrink-0 text-mist-500', strokeWidth: 2, 'aria-hidden': true })}
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <button
                type="button"
                onClick={() => setSpaceHidden(engine, space.id, false)}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-accent-400 hover:bg-ink-800"
                aria-label={t('space.showNamed', { name: space.name })}
                data-testid={`show-space-${space.name}`}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden /> {t('space.show')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ListRow({ list, index }: { list: List; index: number }) {
  const engine = useEngine()
  const view = useView()
  const location = useLocation()
  const [over, setOver] = useState<'list' | 'reminder' | null>(null)
  const count = view.live.filter((r) => r.list_id === list.id && !r.completed_at).length
  const active = location.pathname === `/lists/${list.id}`
  const menu = useListMenu(list)
  return (
    <li
      {...menu}
      draggable
      onDragStart={(event) => {
        dragging.list = list.id
        event.dataTransfer.setData(DRAG_LIST, list.id)
        event.stopPropagation()
      }}
      onDragEnd={() => (dragging.list = null)}
      onDragOver={(event) => {
        if (draggedReminder(event)) {
          event.preventDefault()
          setOver('reminder')
        } else if (takesList(event)) {
          event.preventDefault()
          event.stopPropagation()
          setOver('list')
        }
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => {
        const kind = over
        setOver(null)
        event.preventDefault()
        event.stopPropagation()
        const reminder = draggedReminder(event)
        if (kind === 'reminder' && reminder) {
          const spot = { list_id: list.id, section_id: null, parent_id: null }
          moveReminder(engine, view, reminder, spot, siblingsAt(view, spot, reminder).length)
          return
        }
        const dragged = event.dataTransfer?.getData(DRAG_LIST) || dragging.list
        if (dragged && dragged !== list.id) moveList(engine, view, dragged, list.space_id, index)
      }}
      className={'rounded-lg ' + (over === 'reminder' ? 'ring-2 ring-accent-500' : over === 'list' ? 'border-t-2 border-accent-500' : '')}
    >
      <NavLink
        to={`/lists/${list.id}`}
        data-testid={`list-${list.name}`}
        className={row(active) + ' py-[5px]'}
      >
        <Badge color={list.color} icon={list.icon} size="sm" />
        <span className="min-w-0 flex-1 truncate">{list.name}</span>
        {count > 0 && <span className="text-[12.5px] font-normal text-mist-600 tabular-nums">{count}</span>}
      </NavLink>
    </li>
  )
}
