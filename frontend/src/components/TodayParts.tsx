/**
 * The parts of "Today" around its cards: the week band of the next seven days (a click leads to the day in
 * "Scheduled", a task dropped on a day moves there), and the cards of the right column: how far the day got, the focus
 * of the day, the family's day (where others share a space), "Your week" (alone) and what comes tomorrow.
 */
import { Star, X } from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { moveToDay } from '../lib/actions'
import { draggedReminder } from '../lib/drag'
import { FOCUS_MOST, type Focus } from '../lib/focus'
import { colorOf } from '../lib/look'
import type { BandDay } from '../lib/today'
import type { TodayStats } from '../lib/todayStats'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { Mark } from './Mark'
import { PersonAvatar, personName } from './People'
import { useShell } from './Shell'
import { TickBox } from './TaskParts'

const at = (day: string) => new Date(`${day}T12:00:00`)

/** Takes a dragged task while it is over the element; `drop` gets its id. */
function useDropTarget(drop: (id: string) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (!draggedReminder(event)) return
        event.preventDefault()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        const id = draggedReminder(event)
        setOver(false)
        if (!id) return
        event.preventDefault()
        drop(id)
      },
    },
  }
}

// ---- The week band --------------------------------------------------------------------------------------------------

export function WeekBand({ days, today }: { days: BandDay[]; today: string }) {
  const { t } = useTranslation()
  return (
    // On a phone a strip to swipe through; wider, seven days side by side.
    <nav aria-label={t('today.week.label')} className="-mx-4 mb-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" data-testid="week-band">
      <ol className="grid auto-cols-[minmax(112px,1fr)] grid-flow-col gap-2">
        {days.map((day) => (
          <BandCell key={day.day} day={day} today={today} />
        ))}
      </ol>
    </nav>
  )
}

function BandCell({ day, today }: { day: BandDay; today: string }) {
  const { t, i18n } = useTranslation()
  const view = useView()
  const engine = useEngine()
  const navigate = useNavigate()
  const isToday = day.day === today
  const { over, handlers } = useDropTarget((id) => {
    const reminder = view.reminder(id)
    if (reminder && !reminder.completed_at) moveToDay(engine, reminder, day.day)
  })
  const date = at(day.day)
  const weekday = date.toLocaleDateString(i18n.language, { weekday: 'short' })
  const long = date.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })
  let line: string
  if (isToday) line = day.late ? t('today.week.todayLate', { count: day.count, late: day.late }) : t('today.week.today', { count: day.count })
  else line = day.first ? `${day.count} · ${day.first.title}` : t('today.week.free')
  return (
    <li className="min-w-0">
      <button
        type="button"
        {...handlers}
        onClick={() => navigate(`/scheduled?day=${day.day}`)}
        aria-label={t('today.week.open', { day: long, count: day.count })}
        title={t('today.week.dropHint')}
        data-day={day.day}
        data-testid="band-day"
        className={
          'flex w-full min-w-0 flex-col gap-1.5 rounded-[11px] border px-[11px] py-[9px] text-left transition-colors hover:border-accent-500 ' +
          (over ? 'border-accent-500 bg-accent-wash' : isToday ? 'border-accent-500 bg-ink-850 ring-2 ring-accent-500/25' : 'border-ink-700 bg-ink-850')
        }
      >
        <span className="flex items-baseline justify-between gap-1 text-[12px] text-mist-500">
          <span className="truncate">{weekday}</span>
          <b className={'text-[17px] tabular-nums ' + (isToday ? 'text-accent-400' : 'text-mist-100')}>{date.getDate()}</b>
        </span>
        <span className="flex h-1.5 gap-[3px]" aria-hidden>
          {day.lists.length ? (
            day.lists.map(({ listId, count }) => <i key={listId} className="rounded-[3px]" style={{ flex: count, background: colorOf(view.list(listId)?.color ?? 'gray') }} />)
          ) : (
            <i className="flex-1 rounded-[3px] bg-ink-700" />
          )}
        </span>
        <small className="truncate text-[11.5px] text-mist-500">{line}</small>
      </button>
    </li>
  )
}

// ---- The right column ---------------------------------------------------------------------------------------------

/** A card of the right column: a small head in capitals, what is right of it, the body. */
export function RailCard({ title, side, children, testid, lit = false, drop }: { title?: string; side?: ReactNode; children: ReactNode; testid?: string; lit?: boolean; drop?: ReturnType<typeof useDropTarget>['handlers'] }) {
  return (
    <section className={'flex flex-col gap-2.5 rounded-[12px] border px-4 py-3.5 ' + (lit ? 'border-accent-500 bg-accent-wash' : 'border-ink-700 bg-ink-850')} aria-label={title} data-testid={testid} {...drop}>
      {title && (
        <h2 className="nt-sec flex items-baseline gap-2">
          <span className="min-w-0 truncate">{title}</span>
          {side && <span className="ml-auto shrink-0 text-[12px] font-medium tracking-normal text-mist-600 normal-case">{side}</span>}
        </h2>
      )}
      {children}
    </section>
  )
}

/** The ring of the day: "2 of 5 done", the overdue ones and the run of days below. */
export function ProgressCard({ due, done, overdue, streak }: { due: number; done: number; overdue: number; streak: number | null }) {
  const { t } = useTranslation()
  const share = due ? done / due : 0
  const radius = 23
  const round = 2 * Math.PI * radius
  const left = due - done
  const more = [left && done ? t('today.progress.left', { count: left }) : '', overdue ? t('today.progress.overdue', { count: overdue }) : '', streak ? t('today.progress.streak', { count: streak }) : ''].filter(Boolean).join(' · ')
  return (
    <RailCard testid="today-progress">
      <div className="flex items-center gap-3">
        <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={t('today.progress.ring', { percent: Math.round(share * 100) })} className="shrink-0">
          <circle cx="28" cy="28" r={radius} fill="none" stroke="var(--color-ink-700)" strokeWidth="7" />
          {done > 0 && <circle cx="28" cy="28" r={radius} fill="none" stroke="var(--color-petrol)" strokeWidth="7" strokeLinecap="round" strokeDasharray={round} strokeDashoffset={round * (1 - share)} transform="rotate(-90 28 28)" />}
          <text x="28" y="33" textAnchor="middle" fontSize="14" fontWeight="800" fill="var(--color-mist-100)">
            {Math.round(share * 100)}%
          </text>
        </svg>
        <div className="min-w-0">
          <b className="block text-[15px] text-mist-100" data-testid="progress-line">
            {due ? t('today.progress.done', { done, due }) : t('today.progress.nothingDue')}
          </b>
          {more && <small className="block text-[12px] text-mist-500">{more}</small>}
        </div>
      </div>
    </RailCard>
  )
}

/** The focus of the day: up to three tasks, numbered; a task dropped here or starred in its row comes in. */
export function FocusCard({ focus, items }: { focus: Focus; items: Reminder[] }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const { over, handlers } = useDropTarget((id) => {
    const reminder = view.reminder(id)
    if (reminder && !reminder.completed_at) focus.add(id)
  })
  return (
    <RailCard title={t('today.focus.title')} side={t('today.focus.count', { count: items.length, most: FOCUS_MOST })} testid="today-focus" drop={handlers} lit={over}>
      {items.length ? (
        <ol className="flex flex-col gap-2">
          {items.map((reminder, n) => {
            const done = !!reminder.completed_at
            const id = focus.ids[n]
            return (
              <li key={id} className="group grid grid-cols-[18px_20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] border border-ink-700 px-2.5 py-2" data-testid="focus-item">
                <span className="text-center text-[13px] font-bold text-accent-400 tabular-nums">{n + 1}</span>
                <TickBox done={done} title={reminder.title} onToggle={() => engine.toggle(reminder.id)} small />
                <button type="button" onClick={() => shell.openReminder(reminder.id)} className={'min-w-0 truncate text-left text-[14px] ' + (done ? 'text-mist-500 line-through' : 'text-mist-100')}>
                  {reminder.title}
                </button>
                <button type="button" onClick={() => focus.remove(id)} aria-label={t('today.focus.removeOne', { title: reminder.title })} title={t('today.focus.remove')} className="rounded-md p-0.5 text-mist-500 opacity-0 group-hover:opacity-100 hover:text-mist-100 focus:opacity-100">
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
      {items.length < FOCUS_MOST && (
        <p className="flex items-start gap-2 rounded-[10px] border border-dashed border-ink-600 px-2.5 py-2 text-[12.5px] text-mist-500">
          <Star className="mt-px h-3.5 w-3.5 shrink-0 text-accent-400" aria-hidden />
          {t('today.focus.hint')}
        </p>
      )}
    </RailCard>
  )
}

/** Each person's day in shared spaces: done of what was due for them today, as a bar and "1 / 2". */
export function FamilyCard({ stats }: { stats: TodayStats }) {
  const { t } = useTranslation()
  const view = useView()
  const people = stats.today.people.filter((p) => p.due > 0 || p.done > 0)
  return (
    <RailCard title={t('today.family.title')} testid="today-family">
      {people.length ? (
        people.map((p) => {
          const named = stats.people.find((x) => x.id === p.id)
          const person = p.id !== null ? view.people.get(p.id) : undefined
          const name = named?.name ?? personName(person, t)
          const share = p.due ? (p.due_done / p.due) * 100 : 100
          return (
            <div key={p.id ?? 'former'} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 text-[13px]" data-testid="family-person">
              <PersonAvatar id={p.id ?? 0} person={person} className="h-6 w-6 text-[11px]" />
              <span className="min-w-0">
                <span className="block truncate text-mist-200">{name}</span>
                <span className="mt-1 flex h-1.5 overflow-hidden rounded-[3px] bg-ink-700" role="img" aria-label={t('today.family.of', { name, done: p.due_done, due: p.due })}>
                  <b className="block h-full bg-petrol" style={{ width: `${share}%` }} />
                </span>
              </span>
              <span className="text-[12px] text-mist-500 tabular-nums">{p.due ? `${p.due_done} / ${p.due}` : t('today.family.doneOnly', { count: p.done })}</span>
            </div>
          )
        })
      ) : (
        <p className="text-[13px] text-mist-500">{t('today.family.none')}</p>
      )}
    </RailCard>
  )
}

/** Alone: the last seven days as bars, today dashed (the day is not over). */
export function WeekCard({ days, today, streak }: { days: number[]; today: string; streak: number | null }) {
  const { t, i18n } = useTranslation()
  const top = Math.max(1, ...days)
  const width = 280
  const slot = width / 7
  return (
    <RailCard title={t('today.yourWeek.title')} side={streak ? t('today.yourWeek.streak', { count: streak }) : undefined} testid="today-your-week">
      <svg width="100%" viewBox={`0 0 ${width} 90`} role="img" aria-label={t('today.yourWeek.label', { counts: days.join(', ') })}>
        {days.map((count, n) => {
          const day = addDays(today, n - 6)
          const height = Math.max(4, (count / top) * 62)
          const isToday = n === 6
          const x = n * slot + 5
          return (
            <g key={day}>
              <rect x={x} y={74 - height} width={slot - 10} height={height} rx="5" fill={isToday ? 'var(--color-accent-wash)' : 'var(--color-petrol)'} fillOpacity={isToday ? 1 : 0.35 + 0.65 * (count / top)} stroke={isToday ? 'var(--color-petrol)' : 'none'} strokeWidth="1.5" strokeDasharray={isToday ? '3 2' : undefined}>
                <title>{t('today.yourWeek.day', { day: at(day).toLocaleDateString(i18n.language, { weekday: 'long' }), count })}</title>
              </rect>
              <text x={x + (slot - 10) / 2} y="86" textAnchor="middle" fontSize="10" fontWeight={isToday ? 700 : 400} fill={isToday ? 'var(--color-accent-400)' : 'var(--color-mist-500)'}>
                {at(day).toLocaleDateString(i18n.language, { weekday: 'short' }).replace('.', '').slice(0, 2)}
              </text>
            </g>
          )
        })}
      </svg>
    </RailCard>
  )
}

/** What is due tomorrow: the first few, with their time; the rest as a number that leads to "Scheduled". */
export function TomorrowCard({ items, tomorrow }: { items: Reminder[]; tomorrow: string }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const shell = useShell()
  const navigate = useNavigate()
  const view = useView()
  const shown = items.slice(0, 5)
  return (
    <RailCard title={t('today.tomorrow.title')} side={items.length ? String(items.length) : undefined} testid="today-tomorrow">
      {shown.length ? (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {shown.map((reminder) => {
            const list = view.list(reminder.list_id)
            return (
              <li key={reminder.id} className="flex min-w-0 items-center gap-2">
                <TickBox done={false} title={reminder.title} onToggle={() => engine.toggle(reminder.id)} small />
                {list && <Mark color={list.color} icon={list.icon} size={12} />}
                <button type="button" className="min-w-0 truncate text-left text-mist-200 hover:text-mist-100" onClick={() => shell.openReminder(reminder.id)}>
                  {reminder.title}
                  {reminder.due_time && <span className="text-mist-500"> · {reminder.due_time}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-mist-500">{t('today.tomorrow.none')}</p>
      )}
      {items.length > shown.length && (
        <button type="button" className="self-start text-[12.5px] font-semibold text-accent-400 hover:underline" onClick={() => navigate(`/scheduled?day=${tomorrow}`)}>
          {t('today.tomorrow.more', { count: items.length - shown.length })}
        </button>
      )}
    </RailCard>
  )
}
