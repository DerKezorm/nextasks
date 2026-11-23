/**
 * The left column (docs "Aussehen", "Web"), laid out as nexnotes' sidebar: logo and word mark; "+ New task" and the
 * search; the collections as rows (Today, Scheduled, All, Marked, Assigned to me, Done) with a petrol symbol and their
 * number, those one hid left out; the own filters under the head "Filters" with "+" for a new one; one part per space,
 * its head (the name in capitals, the members of a shared one, "…" and "+" for a new list) above its lists. A list or a
 * filter shows its symbol in its colour (nexnotes' `FolderMark`), its name and its number; under the pointer or with
 * the focus "…" takes the number's place and opens its menu. A new space is made from the menu of any space's head.
 * Lists and spaces are sorted by dragging; a task dropped on a list moves there. Spaces one hid wait folded under
 * "Hidden spaces (n)" to be shown again. At the bottom the trash and how the sync stands; the account with the way to
 * the settings at the foot. The column is as wide as one drags it (`ColumnHandle`, `lib/columns.ts`). On a phone the
 * same is a page of its own, without the handle.
 */
import { ChevronDown, ChevronRight, CloudOff, Eye, EyeOff, FolderPlus, ListPlus, MoreHorizontal, Pencil, Plus, Search, Settings, Trash2, Users } from 'lucide-react'
import { createElement, useState, type DragEvent, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, useLocation } from 'react-router-dom'

import { moveList, moveReminder, moveSpace, setSpaceHidden, siblingsAt } from '../lib/actions'
import { useColumnWidth } from '../lib/columns'
import { localDay } from '../lib/due'
import { dragging, draggedReminder, DRAG_LIST, DRAG_SPACE } from '../lib/drag'
import { TILE_LOOK } from '../lib/tileLook'
import { useAuth } from '../state/auth'
import { useEngine, useFiltersOffered, useSyncState, useView } from '../state/sync'
import { filterCount, shownTiles, tileCount } from '../sync/tiles'
import type { Filter, List, Space } from '../sync/types'
import { Avatar } from './Avatar'
import { ColumnHandle } from './ColumnHandle'
import { Logo } from './Logo'
import { Mark } from './Mark'
import { useFilterMenu, useHideSpace, useListMenu, useSpaceMenu } from './Menus'
import { AvatarStack } from './People'
import { Popover } from './Popover'
import { useShell } from './Shell'

/** A row of the sidebar, as nexnotes' folder rows; the chosen one on the accent's wash with petrol text. On a phone a
 * list keeps the height it had there. */
const row = (active: boolean, tall = false) =>
  'flex items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors ' + (tall ? 'h-[34px] ' : 'h-8 max-md:h-[38px] ') + (active ? 'nt-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800')

/** The number of a row, petrol on the chosen one; with `swap` it gives its place to "…" under the pointer or the focus. */
const counter = (active: boolean, swap = false) =>
  'shrink-0 text-xs tabular-nums ' + (active ? 'text-accent-400 ' : 'text-mist-500 ') + (swap ? 'group-hover:invisible group-focus-within:invisible' : '')

/** "…" of a row: opens the row's context menu just below it. */
function MoreButton({ label }: { label: string }) {
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.dispatchEvent(new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom + 4 }))
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      onClick={open}
      className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded p-0.5 text-mist-400 group-focus-within:block group-hover:block hover:bg-ink-700 hover:text-mist-100"
    >
      <MoreHorizontal aria-hidden className="h-4 w-4" />
    </button>
  )
}

/** The head of a part of the sidebar, as nexnotes': its name small in capitals, folded with a click, buttons on the right. */
function SideHead({ title, open, onToggle, children, ...rest }: { title: string; open: boolean; onToggle: () => void; children?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={'group/head flex items-center gap-1 rounded-lg pr-1 pl-2.5 ' + (rest.className ?? '')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="nt-side-head flex min-w-0 flex-1 items-center gap-1 py-1 text-left hover:text-mist-300">
        <span className="truncate">{title}</span>
        {open ? <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover/head:opacity-100" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
      </button>
      {children}
    </div>
  )
}

/** "+" in a head. */
const PLUS = 'rounded-md p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100'

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
      <div className="nt-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-2.5 pb-2" data-testid="sidebar-places">
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
              <NavLink key={tile} to={`/${tile}`} data-testid={`tile-${tile}`} className={({ isActive }) => row(isActive, true)}>
                {({ isActive }) => (
                  <>
                    {createElement(TILE_LOOK[tile].icon, { className: 'h-4 w-4 shrink-0 text-accent-400', strokeWidth: 1.8, 'aria-hidden': true })}
                    <span className="min-w-0 flex-1 truncate">{t(`tiles.${tile}`)}</span>
                    {count ? (
                      <span className={counter(isActive)} data-testid={`tile-count-${tile}`}>
                        {count}
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            )
          })}
        </nav>

        {filtersOffered && <Filters />}

        <div data-testid="spaces">
          {view.shownSpaces.map((space) => (
            <SpaceBlock key={space.id} space={space} index={view.spaces.indexOf(space)} />
          ))}
        </div>
        {view.hiddenSpaces.length > 0 && <HiddenSpaces />}

        <div className="mt-auto pt-3">
          <div className="border-t border-ink-700 pt-2">
            <NavLink
              to="/trash"
              data-testid="trash-entry"
              className={({ isActive }) => 'flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13.5px] ' + (isActive ? 'nt-chosen font-semibold' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100')}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> {t('trash.title')}
            </NavLink>
            <SyncLine />
          </div>
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

/** The own filters shown, in their order, under the head "Filters" with "+" for a new one. */
function Filters() {
  const { t } = useTranslation()
  const view = useView()
  const shell = useShell()
  const [open, setOpen] = useState(true)
  return (
    <section aria-label={t('filter.section')} className="mt-3" data-testid="filters">
      <SideHead title={t('filter.section')} open={open} onToggle={() => setOpen(!open)}>
        <button type="button" onClick={() => shell.newFilter()} aria-label={t('filter.new')} title={t('filter.new')} className={PLUS} data-testid="new-filter">
          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        </button>
      </SideHead>
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
  const { t } = useTranslation()
  const view = useView()
  const sync = useSyncState()
  const menu = useFilterMenu(filter)
  const count = sync.loaded ? filterCount(view, filter.rules, localDay()) : null
  return (
    <li {...menu} className="group relative">
      <NavLink to={`/filters/${filter.id}`} data-testid={`filter-${filter.name}`} className={({ isActive }) => row(isActive) + ' group-focus-within:pr-8 group-hover:pr-8'}>
        {({ isActive }) => (
          <>
            <Mark color={filter.color} icon={filter.icon} />
            <span className="min-w-0 flex-1 truncate" title={filter.name}>
              {filter.name}
            </span>
            {count ? (
              <span className={counter(isActive, true)} data-testid={`filter-count-${filter.name}`}>
                {count}
              </span>
            ) : null}
          </>
        )}
      </NavLink>
      <MoreButton label={t('filter.menu', { name: filter.name })} />
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
    <section aria-label={space.name} data-space={space.id} className="mt-3">
      <div
        className={'group/space flex items-center gap-1 rounded-lg pr-1 pl-2.5 ' + (over ? 'bg-accent-wash' : '')}
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
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="nt-side-head flex min-w-0 flex-1 items-center gap-1 py-1 text-left hover:text-mist-300">
          <span className="truncate">{space.name}</span>
          {open ? <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover/space:opacity-100" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
        </button>
        {shared.length > 1 && <AvatarStack ids={shared} people={view.people} max={4} />}
        <Popover label={t('space.menu', { name: space.name })} button={<MoreHorizontal className="h-3.5 w-3.5" />} className={PLUS + ' opacity-0 group-hover/space:opacity-100 focus:opacity-100 aria-expanded:bg-accent-wash aria-expanded:text-accent-400 aria-expanded:opacity-100 pointer-coarse:opacity-100'}>
          {(close) => (
            <>
              <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), shell.newList(space.id))}>
                <ListPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('sidebar.newList')}
              </button>
              <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), shell.newSpace())}>
                <FolderPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('sidebar.newSpace')}
              </button>
              <div className="nt-menu-line" role="separator" />
              {manager && (
                <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), shell.editSpace(space.id))}>
                  <Pencil className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('space.edit')}
                </button>
              )}
              {!space.private && (
                <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), shell.members(space.id))}>
                  <Users className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('members.title')}
                </button>
              )}
              <button type="button" className="nt-menu-item" role="menuitem" data-testid="hide-space" onClick={() => (close(), hide(space.id))}>
                <EyeOff className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('space.hide')}
              </button>
            </>
          )}
        </Popover>
        <button type="button" onClick={() => shell.newList(space.id)} aria-label={t('sidebar.newList')} title={t('sidebar.newList')} className={PLUS}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        </button>
      </div>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {lists.map((list, i) => (
            <ListRow key={list.id} list={list} index={i} />
          ))}
          {lists.length === 0 && (
            <li>
              <button type="button" className="px-2.5 py-1.5 text-left text-xs text-mist-500 hover:text-mist-300" onClick={() => shell.newList(space.id)}>
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
  const shell = useShell()
  const [open, setOpen] = useState(false)
  return (
    <section className="mt-3" aria-label={t('space.hiddenSpaces', { count: view.hiddenSpaces.length })} data-testid="hidden-spaces">
      <SideHead title={t('space.hiddenSpaces', { count: view.hiddenSpaces.length })} open={open} onToggle={() => setOpen(!open)}>
        {/* "New space" lives in the menu of a shown space; with none shown it would have no place left. */}
        {view.shownSpaces.length === 0 && (
          <button type="button" onClick={() => shell.newSpace()} aria-label={t('sidebar.newSpace')} title={t('sidebar.newSpace')} className={PLUS} data-testid="new-space-hidden">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          </button>
        )}
      </SideHead>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {view.hiddenSpaces.map((space) => (
            <li key={space.id} className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-mist-300">
              <Mark color={space.color} icon={space.icon} />
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
  const { t } = useTranslation()
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
      className={'group relative rounded-lg ' + (over === 'reminder' ? 'ring-2 ring-accent-500' : over === 'list' ? 'border-t-2 border-accent-500' : '')}
    >
      <NavLink to={`/lists/${list.id}`} data-testid={`list-${list.name}`} className={row(active) + ' group-focus-within:pr-8 group-hover:pr-8'}>
        <Mark color={list.color} icon={list.icon} />
        <span className="min-w-0 flex-1 truncate" title={list.name}>
          {list.name}
        </span>
        {count > 0 && <span className={counter(active, true)}>{count}</span>}
      </NavLink>
      <MoreButton label={t('list.menuNamed', { name: list.name })} />
    </li>
  )
}
