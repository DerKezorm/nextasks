/**
 * One task as a row (docs "Aussehen", principles 3, 5 to 7): the tick box, the title, a line with due date (overdue
 * red with a clock, today petrol), repetition, place, subtasks, files, list and tags; on the right the priority as a
 * word, the bookmark of a marked one and the people it is assigned to. Rows can be dragged; a group of rows takes drops
 * before, after or onto a row (onto: becomes its subtask).
 */
import { ChevronDown, ChevronRight, Clock, Link2, ListTree, MapPin, NotebookText, PanelRightClose, PanelRightOpen, Paperclip, Repeat } from 'lucide-react'
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { moveReminder, siblingsAt, type Spot } from '../lib/actions'
import { dueLabel, localDay, localTime, overdue } from '../lib/due'
import { picturedIn } from '../lib/notes'
import { dragging, draggedReminder, DRAG_REMINDER } from '../lib/drag'
import { useEngine, useView } from '../state/sync'
import type { Reminder } from '../sync/types'
import { ListDot } from './Badge'
import { useTaskMenu } from './Menus'
import { AvatarStack } from './People'
import { useShell } from './Shell'
import { MarkedSign, PriorityPlaque, TickBox } from './TaskParts'

type Zone = 'before' | 'after' | 'into'

function zoneOf(event: DragEvent<HTMLElement>, allowInto: boolean): Zone {
  const rect = event.currentTarget.getBoundingClientRect()
  const y = (event.clientY - rect.top) / Math.max(1, rect.height)
  if (allowInto && y > 0.3 && y < 0.7) return 'into'
  return y < 0.5 ? 'before' : 'after'
}

/** Moves focus to the next or previous row on the page. */
function stepFocus(from: HTMLElement, by: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')]
  const at = rows.indexOf(from)
  rows[at + by]?.focus()
}

export function ReminderRow({ reminder, showList = false, depth = 0, onDropZone, folded, onFold, childCount = 0 }: { reminder: Reminder; showList?: boolean; depth?: number; onDropZone?: (dragged: string, zone: Zone) => void; folded?: boolean; onFold?: () => void; childCount?: number }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [hint, setHint] = useState<Zone | null>(null)
  const list = view.list(reminder.list_id)
  const today = localDay()
  const late = !reminder.completed_at && overdue(reminder, today, localTime())
  const dueToday = !late && !reminder.completed_at && reminder.due_date === today
  const children = view.childrenOf(reminder.id).filter((c) => !view.inTrash(c))
  const done = !!reminder.completed_at
  // Pictures of the note do not count again as files.
  const pictured = picturedIn(reminder.notes)
  const files = view.attachmentsOf(reminder.id).filter((a) => !pictured.has(a.id.toLowerCase())).length
  const open = shell.selected === reminder.id
  const inPane = shell.pane === reminder.id
  const menu = useTaskMenu(reminder)

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const key = event.key.toLowerCase()
    if (event.key === 'ArrowDown') stepFocus(event.currentTarget, 1)
    else if (event.key === 'ArrowUp') stepFocus(event.currentTarget, -1)
    else if (event.key === 'Enter') shell.openReminder(reminder.id)
    else if (key === 'x') engine.toggle(reminder.id)
    else if (key === 'f') engine.put('reminder', reminder.id, { flagged: !reminder.flagged })
    else if (event.key === 'Delete' || event.key === 'Backspace') engine.trash('reminder', reminder.id)
    else return
    event.preventDefault()
  }

  return (
    <div
      data-row
      data-reminder={reminder.id}
      role="listitem"
      tabIndex={0}
      draggable
      aria-label={reminder.title}
      {...menu}
      onKeyDown={onKey}
      onFocus={() => shell.select(reminder.id)}
      onDragStart={(event) => {
        dragging.reminder = reminder.id
        event.dataTransfer.setData(DRAG_REMINDER, reminder.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => {
        dragging.reminder = null
        setHint(null)
      }}
      onDragOver={(event) => {
        if (!onDropZone) return
        const id = draggedReminder(event)
        if (!id || id === reminder.id) return
        event.preventDefault()
        event.stopPropagation()
        setHint(zoneOf(event, depth === 0 && !reminder.parent_id))
      }}
      onDragLeave={() => setHint(null)}
      onDrop={(event) => {
        const id = draggedReminder(event)
        const zone = hint
        setHint(null)
        if (!onDropZone || !id || id === reminder.id || !zone) return
        event.preventDefault()
        event.stopPropagation()
        onDropZone(id, zone)
      }}
      className={
        'group relative flex items-start gap-[11px] px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset ' +
        (open ? 'bg-chosen ' : 'hover:bg-ink-800/60 ') +
        (hint === 'into' ? 'ring-2 ring-accent-500 ring-inset ' : '')
      }
      style={depth ? { paddingLeft: 12 + depth * 33 } : undefined}
    >
      {hint === 'before' && <span className="absolute inset-x-3 -top-px h-0.5 rounded bg-accent-500" />}
      {hint === 'after' && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded bg-accent-500" />}
      <TickBox done={done} title={reminder.title} onToggle={() => engine.toggle(reminder.id)} className="mt-px" />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => shell.openReminder(reminder.id)} tabIndex={-1}>
        <span className={'block text-[15px] leading-snug break-words ' + (done ? 'text-mist-500 line-through' : 'text-mist-100')}>{reminder.title}</span>
        <span className="mt-[3px] flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12.5px] text-mist-500 empty:hidden">
          {reminder.due_date && (
            <span className={'inline-flex items-center gap-1 ' + (late ? 'font-semibold text-bad-500' : dueToday ? 'font-semibold text-accent-400' : '')} data-testid="due">
              {late && <Clock className="h-[13px] w-[13px]" aria-hidden />}
              {dueLabel(reminder, today, i18n.language, t)}
            </span>
          )}
          {reminder.repeat && <Repeat className="h-[13px] w-[13px]" aria-label={t('reminder.repeats')} role="img" />}
          {reminder.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-[13px] w-[13px]" aria-hidden /> {reminder.location.name}
            </span>
          )}
          {children.length > 0 && (
            <span className="inline-flex items-center gap-1" title={t('reminder.subtasks', { done: children.filter((c) => c.completed_at).length, count: children.length })}>
              <ListTree className="h-[13px] w-[13px]" aria-hidden />
              {children.filter((c) => c.completed_at).length}/{children.length}
            </span>
          )}
          {files > 0 && (
            <span className="inline-flex items-center gap-1" title={t('detail.files')}>
              <Paperclip className="h-[13px] w-[13px]" aria-hidden /> {files}
            </span>
          )}
          {reminder.url && <Link2 className="h-[13px] w-[13px]" aria-label={t('detail.url')} role="img" />}
          {showList && list && (
            <span className="inline-flex items-center gap-1.5">
              <ListDot color={list.color} /> {list.name}
            </span>
          )}
          {reminder.tags.map((tag) => (
            <span key={tag} className="text-accent-400">
              #{tag}
            </span>
          ))}
          {reminder.notes.trim() && <NotebookText className="h-[13px] w-[13px]" aria-label={t('reminder.hasNote')} role="img" data-testid="has-note" />}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
        <PriorityPlaque priority={reminder.priority} />
        {reminder.flagged && <MarkedSign />}
        <AvatarStack ids={reminder.assignees} people={view.people} />
        {onFold && childCount > 0 && (
          <button type="button" onClick={onFold} aria-expanded={!folded} aria-label={t(folded ? 'reminder.showSubtasks' : 'reminder.hideSubtasks')} className="rounded-md p-0.5 text-mist-500 hover:text-mist-100">
            {folded ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => shell.togglePane(reminder.id)}
          aria-pressed={inPane}
          aria-label={t('reminder.paneToggleFor', { title: reminder.title })}
          title={t('reminder.paneToggle')}
          data-testid="pane-toggle"
          className={'hidden rounded-md p-0.5 lg:block ' + (inPane ? 'bg-chosen text-accent-400' : 'text-mist-500 opacity-0 group-hover:opacity-100 hover:text-accent-400 focus:opacity-100')}
        >
          {inPane ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </button>
      </span>
    </div>
  )
}

/**
 * The top-level tasks of one place (a list without section, a section, a column) with their subtasks, and the drops
 * into it. `items` are the tasks to show at the top level, already filtered (done ones or not); `only` limits the
 * subtasks shown to those found (tiles, search). In a card the rows are parted by thin lines; on the board each task
 * with its subtasks is a card of its own.
 */
export function ReminderGroup({ spot, items, showDone, showList = false, empty, only, board = false, footer }: { spot: Spot | null; items: Reminder[]; showDone: boolean; showList?: boolean; empty?: string; only?: Set<string>; board?: boolean; footer?: ReactNode }) {
  const engine = useEngine()
  const view = useView()
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [over, setOver] = useState(false)

  const drop = (target: Reminder, dragged: string, zone: Zone) => {
    if (!spot && zone !== 'into') return
    const moving = view.reminder(dragged)
    if (!moving) return
    if (zone === 'into') {
      // Only one level: a reminder with subtasks of its own does not become one.
      if (target.parent_id || view.childrenOf(dragged).length) return
      const into = { list_id: target.list_id, section_id: null, parent_id: target.id }
      moveReminder(engine, view, dragged, into, siblingsAt(view, into, dragged).length)
      return
    }
    const place: Spot = target.parent_id ? { list_id: target.list_id, section_id: null, parent_id: target.parent_id } : spot!
    if (place.parent_id && view.childrenOf(dragged).length) return
    const siblings = siblingsAt(view, place, dragged)
    const at = siblings.findIndex((s) => s.id === target.id)
    moveReminder(engine, view, dragged, place, (at < 0 ? siblings.length : at) + (zone === 'after' ? 1 : 0))
  }

  return (
    <div
      className={(board ? 'flex min-h-8 flex-1 flex-col ' : 'nt-group ') + (over ? 'bg-accent-500/5' : '')}
      onDragOver={(event) => {
        if (!spot || !draggedReminder(event)) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        const id = draggedReminder(event)
        if (!spot || !id) return
        event.preventDefault()
        moveReminder(engine, view, id, spot, siblingsAt(view, spot, id).length)
      }}
    >
      <div role="list" className={board ? 'nt-board flex flex-col gap-2' : 'nt-rows'}>
        {items.length === 0 && empty && <p className="px-3 py-3 text-sm text-mist-600">{empty}</p>}
        {items.map((reminder) => {
          // In a tile or a search only the subtasks that belong there show under their parent.
          const children = view.childrenOf(reminder.id).filter((c) => !view.inTrash(c) && (showDone || !c.completed_at) && (!only || only.has(c.id)))
          const shut = !!folded[reminder.id]
          return (
            <div key={reminder.id} className={board ? 'nt-card overflow-hidden' : undefined}>
              <ReminderRow
                reminder={reminder}
                showList={showList}
                onDropZone={(dragged, zone) => drop(reminder, dragged, zone)}
                folded={shut}
                childCount={children.length}
                onFold={() => setFolded((f) => ({ ...f, [reminder.id]: !shut }))}
              />
              {!shut &&
                children.map((child) => <ReminderRow key={child.id} reminder={child} depth={1} showList={false} onDropZone={(dragged, zone) => drop(child, dragged, zone)} />)}
            </div>
          )
        })}
      </div>
      {footer}
    </div>
  )
}
