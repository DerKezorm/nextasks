/**
 * "Scheduled" as day columns (switched in the head, as nexnotes' "Ansicht"; the choice is this device's): every day
 * from today a column of its own, also an empty one, as many side by side as the width holds; under each head the
 * tasks of the day as small cards, in the order of the list. "Overdue" comes first on the first page when there is
 * something overdue. A card dragged to another day gets that date and keeps its time (the same change as a new date in
 * the detail, `dueChange`); with the keys the date stays the detail's. "+" at the foot of a day makes a task on it.
 */
import { ChevronLeft, ChevronRight, Clock, Columns3, List as ListIcon, ListTree, Plus, Repeat, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { createElement, useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { moveToDay, trashReminder } from '../lib/actions'
import { dayColumns, type DayPaging, type ScheduledLook } from '../lib/dayColumns'
import { dayLabel, dueLabel, localTime, longDay, overdue } from '../lib/due'
import { dragging, draggedReminder, DRAG_REMINDER } from '../lib/drag'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { Mark } from './Mark'
import { useTaskMenu } from './Menus'
import { AvatarStack } from './People'
import { Popover } from './Popover'
import { QuickEntry } from './QuickEntry'
import { useShell } from './Shell'
import { MarkedSign, PriorityPlaque, TickBox } from './TaskParts'

/** The button "View" in the head and its menu: list or columns. */
export function ScheduledViewMenu({ look, onLook }: { look: ScheduledLook; onLook: (look: ScheduledLook) => void }) {
  const { t } = useTranslation()
  const choices: { look: ScheduledLook; icon: LucideIcon; label: string }[] = [
    { look: 'list', icon: ListIcon, label: t('tiles.asList') },
    { look: 'columns', icon: Columns3, label: t('tiles.asColumns') },
  ]
  return (
    <Popover label={t('tiles.view')} button={<SlidersHorizontal className="h-4 w-4" strokeWidth={2.1} aria-hidden />} className="nt-icon-btn">
      {(close) => (
        <div role="group" aria-label={t('tiles.view')}>
          <p aria-hidden className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mist-600 uppercase">
            {t('tiles.view')}
          </p>
          {choices.map((choice) => {
            const on = look === choice.look
            return (
              <button
                key={choice.look}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                data-testid={`scheduled-look-${choice.look}`}
                className={'nt-menu-item ' + (on ? 'font-semibold text-accent-400' : '')}
                onClick={() => {
                  close()
                  if (!on) onLook(choice.look)
                }}
              >
                {createElement(choice.icon, { className: 'h-4 w-4 shrink-0 text-mist-500', strokeWidth: 2, 'aria-hidden': true })}
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </Popover>
  )
}

/** What a page holds: as many days as it shows; back never before today. */
function stepsOf(items: Reminder[], today: string, paging: DayPaging) {
  const { days } = dayColumns(items, today, paging.start, paging.count)
  return { forward: paging.start + days.length, back: Math.max(0, paging.start - paging.count) }
}

/** Back a page, to today, on a page: in the head next to "View". */
export function DayNav({ items, today, paging }: { items: Reminder[]; today: string; paging: DayPaging }) {
  const { t } = useTranslation()
  const steps = stepsOf(items, today, paging)
  return (
    <span className="mr-1 flex items-center gap-0.5" data-testid="day-nav">
      <button type="button" className="nt-icon-btn" disabled={paging.start === 0} onClick={() => paging.setStart(steps.back)} aria-label={t('tiles.earlier')} title={t('tiles.earlier')}>
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" className="h-8 rounded-lg px-2.5 text-[13px] font-semibold text-mist-300 not-disabled:hover:bg-ink-800 not-disabled:hover:text-mist-100 disabled:cursor-default disabled:opacity-40" disabled={paging.start === 0} onClick={() => paging.setStart(0)} title={t('tiles.toToday')}>
        {t('due.today')}
      </button>
      <button type="button" className="nt-icon-btn" onClick={() => paging.setStart(steps.forward)} aria-label={t('tiles.later')} title={t('tiles.later')}>
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </span>
  )
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** The columns themselves. `items`: the open tasks with a date, sorted as the list sorts them. */
export function DayBoard({ items, today, paging }: { items: Reminder[]; today: string; paging: DayPaging }) {
  const { t, i18n } = useTranslation()
  const board = useRef<HTMLDivElement | null>(null)
  const { overdue: late, days } = dayColumns(items, today, paging.start, paging.count)
  const steps = stepsOf(items, today, paging)
  const columns = (late ? 1 : 0) + days.length

  // ← and → turn the page while the focus is on the board or nowhere (not in a field, a menu, a dialog).
  const { setStart, start } = paging
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target as HTMLElement | null
      if (typing(target) || !(target === document.body || (target && board.current?.contains(target)))) return
      if (event.key === 'ArrowLeft' && start === 0) return
      event.preventDefault()
      setStart(event.key === 'ArrowLeft' ? steps.back : steps.forward)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setStart, start, steps.back, steps.forward])

  const setBoard = useCallback(
    (element: HTMLDivElement | null) => {
      board.current = element
      paging.measure(element)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paging.measure],
  )

  return (
    <div ref={setBoard} className="grid items-start gap-3 pb-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} data-testid="day-board">
      {late && <DayColumnView day={null} items={late} today={today} label={t('tiles.overdue')} />}
      {days.map(({ day, items: group }) => (
        <DayColumnView key={day} day={day} items={group} today={today} label={longDay(day, i18n.language)} />
      ))}
    </div>
  )
}

/** The head of a day: "Today", "Tomorrow" or the weekday, below the date; the number on the right. */
function DayHead({ day, today, count }: { day: string | null; today: string; count: number }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  let word: string
  let date: string | null = null
  if (!day) word = t('tiles.overdue')
  else {
    const at = new Date(`${day}T12:00:00`)
    const near = day === today || day === addDays(today, 1)
    word = near ? dayLabel(day, today, language, t) : at.toLocaleDateString(language, { weekday: 'long' })
    const sameYear = day.slice(0, 4) === today.slice(0, 4)
    date = at.toLocaleDateString(language, { ...(near ? { weekday: 'long' } : {}), day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
  }
  const isToday = day === today
  const tone = !day ? 'text-late' : isToday ? 'text-accent-400' : ''
  return (
    <header className="px-1.5 pt-0.5 pb-2">
      <div className="flex items-baseline gap-1.5">
        <h2 className={'nt-sec min-w-0 truncate ' + tone}>{word}</h2>
        <span className={'ml-auto shrink-0 text-[11px] font-medium tabular-nums ' + (tone || 'text-mist-600')} data-testid="day-count">
          {count}
        </span>
      </div>
      {date && <p className={'mt-0.5 truncate text-[13px] font-semibold ' + (isToday ? 'text-accent-400' : 'text-mist-200')}>{date}</p>}
    </header>
  )
}

/** One column: its head, its cards (a subtask in its task's card when both are on the day), "+" at the foot. */
function DayColumnView({ day, items, today, label }: { day: string | null; items: Reminder[]; today: string; label: string }) {
  const engine = useEngine()
  const view = useView()
  const [over, setOver] = useState(false)
  const here = new Set(items.map((r) => r.id))
  const tops = items.filter((r) => !r.parent_id || !here.has(r.parent_id))
  const isToday = day === today

  // A drag given up (Escape, dropped outside) leaves no column marked.
  useEffect(() => {
    if (!over) return
    const end = () => setOver(false)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [over])

  const droppable = (event: DragEvent) => {
    if (!day) return null
    const id = draggedReminder(event)
    return id && view.reminder(id) ? id : null
  }

  return (
    <section
      aria-label={label}
      data-day={day ?? 'overdue'}
      data-over={over || undefined}
      className={
        'flex min-w-0 flex-col rounded-[12px] border p-2 transition-colors ' +
        (over ? 'border-accent-500 bg-accent-wash ' : isToday ? 'border-accent-500/60 bg-ink-900 ' : 'border-ink-700 bg-ink-900 ')
      }
      onDragOver={(event) => {
        if (!droppable(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        setOver(false)
        const id = droppable(event)
        if (!id || !day) return
        event.preventDefault()
        moveToDay(engine, view.reminder(id)!, day)
      }}
    >
      <DayHead day={day} today={today} count={items.length} />
      <div role="list" className="flex min-h-10 flex-col gap-1.5">
        {tops.map((reminder) => (
          <div key={reminder.id} className="nt-card overflow-hidden">
            <DayCard reminder={reminder} today={today} lateColumn={!day} />
            {items
              .filter((c) => c.parent_id === reminder.id)
              .map((child) => (
                <DayCard key={child.id} reminder={child} today={today} lateColumn={!day} sub />
              ))}
          </div>
        ))}
      </div>
      {day && <AddOnDay day={day} />}
    </section>
  )
}

/** "+" at the foot of a day: the quick entry with that date, as the line under the list. */
function AddOnDay({ day }: { day: string }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLInputElement>('[data-testid="quick-entry"]')?.focus()
  }, [open])
  const when = longDay(day, i18n.language)
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('tiles.addOn', { day: when })}
        title={t('tiles.addOn', { day: when })}
        data-testid="day-add"
        className="mt-1.5 flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-[13px] text-mist-500 opacity-70 hover:bg-ink-800 hover:text-mist-100 hover:opacity-100 focus-visible:opacity-100"
      >
        <Plus className="h-4 w-4" aria-hidden /> {t('reminder.new')}
      </button>
    )
  return (
    <div
      ref={box}
      className="-mx-1 mt-1"
      onBlur={(event) => {
        const field = box.current?.querySelector<HTMLInputElement>('[data-testid="quick-entry"]')
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !field?.value) setOpen(false)
      }}
      onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
    >
      <QuickEntry spot={null} register={false} label={t('tiles.addOn', { day: when })} defaults={{ due_date: day, due_time: null, repeat: null, repeat_from: 'due' }} />
    </div>
  )
}

/** Moves the focus to the next or previous card of the same column. */
function stepInColumn(from: HTMLElement, by: number): void {
  const column = from.closest('section')
  if (!column) return
  const cards = [...column.querySelectorAll<HTMLElement>('[data-reminder]')]
  cards[cards.indexOf(from) + by]?.focus()
}

/** A task as a small card: the same parts as a row of the list, closer together. */
function DayCard({ reminder, today, lateColumn, sub = false }: { reminder: Reminder; today: string; lateColumn: boolean; sub?: boolean }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const menu = useTaskMenu(reminder)
  const [lifted, setLifted] = useState(false)
  const list = view.list(reminder.list_id)
  const late = overdue(reminder, today, localTime())
  const subtasks = view.childrenOf(reminder.id).filter((c) => !view.inTrash(c))
  const open = shell.selected === reminder.id
  // In "Overdue" the days differ, so the card says which; a day's column says only the time.
  const when = lateColumn ? dueLabel(reminder, today, i18n.language, t) : (reminder.due_time ?? '')

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const key = event.key.toLowerCase()
    if (event.key === 'ArrowDown') stepInColumn(event.currentTarget, 1)
    else if (event.key === 'ArrowUp') stepInColumn(event.currentTarget, -1)
    else if (event.key === 'Enter') shell.openReminder(reminder.id)
    else if (key === 'x') engine.toggle(reminder.id)
    else if (key === 'f') engine.put('reminder', reminder.id, { flagged: !reminder.flagged })
    else if (event.key === 'Delete' || event.key === 'Backspace') trashReminder(engine, reminder, (title) => t('reminder.trashed', { title }))
    else return
    event.preventDefault()
  }

  return (
    <div
      data-reminder={reminder.id}
      data-chosen={open || undefined}
      data-testid="day-card"
      role="listitem"
      tabIndex={0}
      draggable
      aria-label={reminder.title}
      {...menu}
      onKeyDown={onKey}
      onFocus={(event) => event.target === event.currentTarget && shell.select(reminder.id)}
      onDragStart={(event) => {
        event.stopPropagation()
        dragging.reminder = reminder.id
        event.dataTransfer.setData(DRAG_REMINDER, reminder.id)
        event.dataTransfer.effectAllowed = 'move'
        setLifted(true)
      }}
      onDragEnd={() => {
        dragging.reminder = null
        setLifted(false)
      }}
      className={
        'relative outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ' +
        (sub ? 'border-t border-ink-700 py-1.5 pr-2.5 pl-[34px] ' : 'px-2.5 py-2 ') +
        (open ? 'bg-accent-wash ' : 'hover:bg-ink-800 ') +
        (lifted ? 'opacity-50' : '')
      }
    >
      <div className="flex items-start gap-2">
        <TickBox done={!!reminder.completed_at} title={reminder.title} onToggle={() => engine.toggle(reminder.id)} small className="mt-px" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => shell.openReminder(reminder.id)} tabIndex={-1}>
          <span className={'block leading-snug break-words text-mist-100 ' + (sub ? 'text-[13px]' : 'text-[13.5px]')}>{reminder.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-mist-500 empty:hidden">
            {when && (
              <span className={'inline-flex items-center gap-1 tabular-nums ' + (late ? 'font-semibold text-late' : '')} data-testid="due">
                {late && <Clock className="h-3 w-3" aria-hidden />}
                {when}
              </span>
            )}
            {reminder.repeat && <Repeat className="h-3 w-3" aria-label={t('reminder.repeats')} role="img" />}
            {subtasks.length > 0 && (
              <span className="inline-flex items-center gap-1" title={t('reminder.subtasks', { done: subtasks.filter((c) => c.completed_at).length, count: subtasks.length })}>
                <ListTree className="h-3 w-3" aria-hidden />
                {subtasks.filter((c) => c.completed_at).length}/{subtasks.length}
              </span>
            )}
            {!sub && list && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Mark color={list.color} icon={list.icon} size={12} /> <span className="truncate">{list.name}</span>
              </span>
            )}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1 pt-px">
          <PriorityPlaque priority={reminder.priority} />
          {reminder.flagged && <MarkedSign />}
          <AvatarStack ids={reminder.assignees} people={view.people} max={2} />
        </span>
      </div>
    </div>
  )
}
