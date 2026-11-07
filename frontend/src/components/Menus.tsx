/**
 * What the context menu offers on a task, a list and a space: the actions the web has elsewhere already (the "…"
 * menus, the detail, the dialogs), nothing the server could not do. A member sees no manager's entries.
 */
import { Bell, Bookmark, CalendarDays, Check, ChevronsUp, Columns3, Eye, EyeOff, FolderInput, Link2, List as ListIcon, ListPlus, ListTree, LogOut, PanelRightOpen, Pencil, RotateCcw, SquareArrowOutUpRight, Trash2, UserPlus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { moveList, moveReminder, setPref, setSpaceHidden, siblingsAt } from '../lib/actions'
import { copyText } from '../lib/copy'
import { localDay } from '../lib/due'
import { colorOf } from '../lib/look'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import type { List, Reminder, Space } from '../sync/types'
import { useContextMenu, type MenuItems } from './ContextMenu'
import { personName } from './People'
import { useShell } from './Shell'

const wide = () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches

/** The menu of a task: in a list, a collection, the search, on the board, as a subtask. */
export function useTaskMenu(reminder: Reminder) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  return useContextMenu((): MenuItems => {
    const id = reminder.id
    const list = view.list(reminder.list_id)
    const space = list ? view.space(list.space_id) : undefined
    const members = space && !space.private ? view.membersOf(space.id) : []
    const put = (fields: Record<string, unknown>) => engine.put('reminder', id, fields)
    const due = (date: string | null) => put({ due_date: date, due_time: date ? reminder.due_time : null, repeat: date ? reminder.repeat : null, repeat_from: date ? reminder.repeat_from : 'due' })
    const today = localDay()
    const move = (spot: { list_id: string; section_id: string | null; parent_id: null }) => moveReminder(engine, view, id, spot, siblingsAt(view, spot, id).length)
    return [
      { label: t('menu.open'), icon: SquareArrowOutUpRight, keys: 'Enter', run: () => shell.openReminder(id) },
      wide() && { label: t(shell.pane === id ? 'menu.hideInPane' : 'menu.showInPane'), icon: PanelRightOpen, run: () => shell.togglePane(id) },
      'line',
      { label: t(reminder.completed_at ? 'menu.reopen' : 'menu.complete'), icon: Check, keys: 'X', run: () => engine.toggle(id) },
      { label: t(reminder.flagged ? 'menu.unmark' : 'menu.mark'), icon: Bookmark, keys: 'F', run: () => put({ flagged: !reminder.flagged }) },
      { label: t('detail.priority'), icon: ChevronsUp, items: [0, 1, 2, 3].map((p) => ({ label: t(`priority.${p}`), checked: reminder.priority === p, run: () => put({ priority: p }) })) },
      {
        label: t('detail.due'),
        icon: CalendarDays,
        items: [
          { label: t('detail.today'), checked: reminder.due_date === today, run: () => due(today) },
          { label: t('menu.tomorrow'), checked: reminder.due_date === addDays(today, 1), run: () => due(addDays(today, 1)) },
          { label: t('menu.nextWeek'), checked: reminder.due_date === addDays(today, 7), run: () => due(addDays(today, 7)) },
          'line',
          { label: t('detail.noDate'), disabled: !reminder.due_date, run: () => due(null) },
        ],
      },
      members.length > 0 && {
        label: t('menu.assign'),
        icon: Users,
        items: members.map((m) => {
          const on = reminder.assignees.includes(m.account_id)
          return { label: personName(view.people.get(m.account_id), t), checked: on, run: () => put({ assignees: on ? reminder.assignees.filter((x) => x !== m.account_id) : [...reminder.assignees, m.account_id] }) }
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
            if (!sections.length) return { label: l.name, color: colorOf(l.color), disabled: here && !reminder.section_id, run: () => move({ list_id: l.id, section_id: null, parent_id: null }) }
            return {
              label: l.name,
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
          engine.trash('reminder', id)
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
      others.length > 0 && { label: t('menu.moveToSpace'), icon: FolderInput, items: others.map((s) => ({ label: s.name, color: colorOf(s.color), run: () => moveList(engine, view, list.id, s.id, view.listsOf(s.id).length) })) },
      'line',
      {
        label: t('list.delete'),
        icon: Trash2,
        danger: true,
        confirm: t('list.deleteSure'),
        run: () => {
          engine.trash('list', list.id)
          if (window.location.pathname === `/lists/${list.id}`) navigate('/today')
        },
      },
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
          confirm: t('space.deleteSure'),
          run: () => {
            engine.trash('space', space.id)
            navigate('/today')
          },
        },
    ]
  })
}

/** The menu of an entry of the trash: bring it back (for good the server removes it by itself after 30 days). */
export function useTrashMenu(restore: (() => void) | null) {
  const { t } = useTranslation()
  return useContextMenu((): MenuItems => (restore ? [{ label: t('trash.restore'), icon: RotateCcw, run: restore }] : []))
}
