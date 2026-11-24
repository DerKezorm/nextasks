/**
 * What the context menu offers on a task, a list, a space and an own filter: the actions the web has elsewhere already (the "…"
 * menus, the detail, the dialogs), nothing the server could not do. A member sees no manager's entries.
 */
import { Bell, Bookmark, CalendarDays, Check, ChevronsUp, Columns3, Eye, EyeOff, FolderInput, FolderPlus, Link2, List as ListIcon, ListPlus, ListTree, LogOut, PanelRightOpen, Pencil, RotateCcw, SquareArrowOutUpRight, Star, Trash2, UserPlus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { deleteFilter, dueChange, moveList, moveReminder, setFilterHidden, setPref, setSpaceHidden, siblingsAt, trashReminder } from '../lib/actions'
import { copyText } from '../lib/copy'
import { localDay } from '../lib/due'
import { useFocusOffered } from '../lib/focus'
import { assignable } from '../lib/shared'
import { parkReminder, SOMEDAY_ICON } from '../lib/someday'
import { colorOf, iconFor } from '../lib/look'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import { offered, pickAssignee } from '../sync/rotation'
import type { Filter, List, Reminder, Space } from '../sync/types'
import type { Question } from './ConfirmDialog'
import { useContextMenu, type MenuItems } from './ContextMenu'
import { personName } from './People'
import { useShell } from './Shell'

type T = (key: string, values?: Record<string, unknown>) => string

/** The questions before deleting a list, a space, a filter: the same from the menus and from the dialogs. */
export function askTrashList(list: List, t: T, run: () => void): Question {
  return { title: t('list.deleteTitle', { name: list.name }), text: t('list.deleteText'), confirm: t('list.delete'), run }
}

export function askTrashSpace(space: Space, t: T, run: () => void): Question {
  return { title: t('space.deleteTitle', { name: space.name }), text: t('space.deleteText'), confirm: t('space.delete'), run }
}

export function askDeleteFilter(filter: Filter, t: T, run: () => void): Question {
  return { title: t('filter.deleteTitle', { name: filter.name }), text: t('filter.deleteText'), final: true, confirm: t('filter.delete'), run }
}

const wide = () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches

/** The menu of a task: in a list, a collection, the search, on the board, as a subtask. */
export function useTaskMenu(reminder: Reminder) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const focus = useFocusOffered()
  return useContextMenu((): MenuItems => {
    const id = reminder.id
    const list = view.list(reminder.list_id)
    const space = list ? view.space(list.space_id) : undefined
    // Only where others share the space: alone, there is nobody to assign to.
    const members = assignable(view, reminder.list_id)
    const put = (fields: Record<string, unknown>) => engine.put('reminder', id, fields)
    const due = (date: string | null) => put(dueChange(reminder, date, reminder.due_time))
    const today = localDay()
    const move = (spot: { list_id: string; section_id: string | null; parent_id: null }) => moveReminder(engine, view, id, spot, siblingsAt(view, spot, id).length)
    return [
      { label: t('menu.open'), icon: SquareArrowOutUpRight, keys: 'Enter', run: () => shell.openReminder(id) },
      wide() && { label: t(shell.pane === id ? 'menu.hideInPane' : 'menu.showInPane'), icon: PanelRightOpen, run: () => shell.togglePane(id) },
      'line',
      { label: t(reminder.completed_at ? 'menu.reopen' : 'menu.complete'), icon: Check, keys: 'X', run: () => engine.toggle(id) },
      { label: t(reminder.flagged ? 'menu.unmark' : 'menu.mark'), icon: Bookmark, keys: 'F', run: () => put({ flagged: !reminder.flagged }) },
      // The focus of the day, on "Today" only.
      focus?.ready && !reminder.completed_at && { label: t(focus.has(id) ? 'today.focus.remove' : focus.full ? 'today.focus.full' : 'today.focus.add'), icon: Star, checked: focus.has(id), disabled: !focus.has(id) && focus.full, run: () => focus.toggle(id) },
      { label: t('detail.priority'), icon: ChevronsUp, items: [0, 1, 2, 3].map((p) => ({ label: t(`priority.${p}`), checked: reminder.priority === p, run: () => put({ priority: p }) })) },
      {
        label: t('detail.due'),
        icon: CalendarDays,
        items: [
          { label: t('detail.today'), checked: reminder.due_date === today, run: () => due(today) },
          { label: t('menu.tomorrow'), checked: reminder.due_date === addDays(today, 1), run: () => due(addDays(today, 1)) },
          { label: t('menu.nextWeek'), checked: reminder.due_date === addDays(today, 7), run: () => due(addDays(today, 7)) },
          'line',
          { label: t('someday.set'), icon: SOMEDAY_ICON, disabled: !reminder.due_date, run: () => parkReminder(engine, reminder, (title) => t('someday.moved', { title })) },
        ],
      },
      members.length > 0 && {
        label: t('menu.assign'),
        icon: Users,
        items: offered(reminder, members).map((m) => {
          const on = reminder.assignees.includes(m.account_id)
          return { label: personName(view.people.get(m.account_id), t), checked: on, run: () => put({ assignees: pickAssignee(reminder, m.account_id) }) }
        }),
      },
      {
        label: t('menu.moveTo'),
        icon: FolderInput,
        items: view.spaces.filter((s) => !view.isHidden(s.id) || s.id === space?.id).flatMap((s, n): MenuItems => [
          n > 0 && 'line',
          ...view.listsOf(s.id).map((l) => {
            const sections = reminder.parent_id ? [] : view.sectionsOf(l.id)
            const here = l.id === reminder.list_id
            if (!sections.length) return { label: l.name, icon: iconFor(l.icon), color: colorOf(l.color), disabled: here && !reminder.section_id, run: () => move({ list_id: l.id, section_id: null, parent_id: null }) }
            return {
              label: l.name,
              icon: iconFor(l.icon),
              color: colorOf(l.color),
              items: [{ label: t('list.noSection'), checked: here && !reminder.section_id, run: () => move({ list_id: l.id, section_id: null, parent_id: null }) }, ...sections.map((sec) => ({ label: sec.name, checked: here && reminder.section_id === sec.id, run: () => move({ list_id: l.id, section_id: sec.id, parent_id: null }) }))],
            }
          }),
        ]),
      },
      'line',
      !reminder.parent_id && {
        label: t('menu.addSubtask'),
        icon: ListTree,
        run: () => {
          shell.openReminder(id)
          setTimeout(() => document.querySelector<HTMLInputElement>(`[data-testid="detail"] input[aria-label="${t('detail.addSubtask')}"]`)?.focus(), 50)
        },
      },
      { label: t('menu.copyLink'), icon: Link2, run: () => void copyText(`${window.location.origin}/lists/${reminder.list_id}?reminder=${id}`) },
      'line',
      {
        label: t('detail.delete'),
        icon: Trash2,
        danger: true,
        keys: t('keys.del'),
        run: () => {
          trashReminder(engine, reminder, (title) => t('reminder.trashed', { title }))
          if (shell.selected === id) shell.closeReminder()
          if (shell.pane === id) shell.closePane()
        },
      },
    ]
  })
}

/** The menu of a list in the sidebar. */
export function useListMenu(list: List) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const navigate = useNavigate()
  const location = useLocation()
  return useContextMenu((): MenuItems => {
    const space = view.space(list.space_id)
    const pref = view.pref(list.id)
    const others = view.shownSpaces.filter((s) => s.id !== list.space_id)
    return [
      { label: t('menu.open'), icon: SquareArrowOutUpRight, run: () => navigate(`/lists/${list.id}`) },
      { label: t('menu.editList'), icon: Pencil, run: () => shell.editList(list.id) },
      'line',
      { label: t(list.view === 'list' ? 'list.asColumns' : 'list.asList'), icon: list.view === 'list' ? Columns3 : ListIcon, run: () => engine.put('list', list.id, { view: list.view === 'list' ? 'columns' : 'list' }) },
      { label: t('list.showDone'), icon: Eye, checked: pref.show_completed, run: () => setPref(engine, list.id, { show_completed: !pref.show_completed }) },
      space && !space.private && { label: t('list.notifyOn'), icon: Bell, checked: pref.notify_changes, run: () => setPref(engine, list.id, { notify_changes: !pref.notify_changes }) },
      others.length > 0 && { label: t('menu.moveToSpace'), icon: FolderInput, items: others.map((s) => ({ label: s.name, icon: iconFor(s.icon), color: colorOf(s.color), run: () => moveList(engine, view, list.id, s.id, view.listsOf(s.id).length) })) },
      'line',
      { label: t('list.delete'), icon: Trash2, danger: true, run: () => shell.ask(askTrashList(list, t, () => {
        engine.trash('list', list.id)
        if (location.pathname === `/lists/${list.id}`) navigate('/today')
      })) },
    ]
  })
}

/** Hides a space for oneself; a page of one of its lists that is open goes to "Today". */
export function useHideSpace(): (spaceId: string) => void {
  const engine = useEngine()
  const view = useView()
  const navigate = useNavigate()
  const location = useLocation()
  return (spaceId) => {
    setSpaceHidden(engine, spaceId, true)
    const open = /^\/lists\/([^/]+)/.exec(location.pathname)?.[1]
    if (open && view.list(open)?.space_id === spaceId) navigate('/today')
  }
}

/** The menu of a space's head in the sidebar. */
export function useSpaceMenu(space: Space) {
  const { t } = useTranslation()
  const engine = useEngine()
  const shell = useShell()
  const navigate = useNavigate()
  const hide = useHideSpace()
  return useContextMenu((): MenuItems => {
    const manager = space.role === 'manager'
    return [
      { label: t('sidebar.newList'), icon: ListPlus, run: () => shell.newList(space.id) },
      { label: t('sidebar.newSpace'), icon: FolderPlus, run: () => shell.newSpace() },
      'line',
      manager && { label: t('menu.editSpace'), icon: Pencil, run: () => shell.editSpace(space.id) },
      { label: t('space.hide'), icon: EyeOff, run: () => hide(space.id) },
      !space.private && 'line',
      !space.private && { label: t('menu.members'), icon: Users, run: () => shell.members(space.id) },
      !space.private && manager && { label: t('menu.invite'), icon: UserPlus, run: () => shell.members(space.id) },
      !space.private && { label: t('menu.leave'), icon: LogOut, run: () => shell.members(space.id) },
      !space.private && manager && 'line',
      !space.private &&
        manager && {
          label: t('space.delete'),
          icon: Trash2,
          danger: true,
          run: () =>
            shell.ask(
              askTrashSpace(space, t, () => {
                engine.trash('space', space.id)
                navigate('/today')
              }),
            ),
        },
    ]
  })
}

/** The menu of an own filter in the sidebar: open, change, hide (it stays in the settings), delete for good. */
export function useFilterMenu(filter: Filter) {
  const { t } = useTranslation()
  const engine = useEngine()
  const shell = useShell()
  const navigate = useNavigate()
  const location = useLocation()
  return useContextMenu((): MenuItems => [
    { label: t('menu.open'), icon: SquareArrowOutUpRight, run: () => navigate(`/filters/${filter.id}`) },
    { label: t('menu.editFilter'), icon: Pencil, run: () => shell.editFilter(filter.id) },
    { label: t('filter.hide'), icon: EyeOff, run: () => setFilterHidden(engine, filter.id, true) },
    'line',
    {
      label: t('filter.delete'),
      icon: Trash2,
      danger: true,
      run: () =>
        shell.ask(
          askDeleteFilter(filter, t, () => {
            deleteFilter(engine, filter.id)
            if (location.pathname === `/filters/${filter.id}`) navigate('/today')
          }),
        ),
    },
  ])
}

/** The menu of an entry of the trash: bring it back (for good the server removes it by itself after 30 days). */
export function useTrashMenu(restore: (() => void) | null) {
  const { t } = useTranslation()
  return useContextMenu((): MenuItems => (restore ? [{ label: t('trash.restore'), icon: RotateCcw, run: restore }] : []))
}
