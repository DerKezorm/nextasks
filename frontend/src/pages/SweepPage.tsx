/**
 * The look through ("Rückschau"): old and overdue tasks one at a time, each as a card with its list, how long it has
 * been open, when it was changed last and its due date. Keep (it stays away for 30 days), next week, someday (no date)
 * or drop (into the trash, with "Undo"); by keys too (B, N, I, Del in German; K, N, S, Del in English). "4 of 11"
 * and a bar on top; at the end what happened. Tasks done or binned elsewhere meanwhile are passed over.
 */
import { ArrowRight, Bookmark, CalendarClock, CalendarOff, Trash2, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { QuietEmpty } from '../components/EmptyState'
import { Plaque } from '../components/Mark'
import { PageHead, TileIcon } from '../components/PageHead'
import { AvatarStack } from '../components/People'
import { useShell } from '../components/Shell'
import { dueChange, trashReminder } from '../lib/actions'
import { localDay } from '../lib/due'
import { isSharedList } from '../lib/shared'
import { SOMEDAY_ICON } from '../lib/someday'
import { keepTask, readSweep, SWEEP_ICON, type SweepAnswer, type SweepTask } from '../lib/sweep'
import { useEngine, useSyncState, useView } from '../state/sync'
import { addDays } from '../sync/repeat'

type Choice = 'kept' | 'moved' | 'parked' | 'dropped'
const NONE: Record<Choice, number> = { kept: 0, moved: 0, parked: 0, dropped: 0 }

/** "8 October": a day without its weekday. */
function shortDate(day: string, language: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(language, { day: 'numeric', month: 'long' })
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function SweepPage() {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const sync = useSyncState()
  const shell = useShell()
  const today = localDay()
  const [answer, setAnswer] = useState<SweepAnswer | null>(null)
  const [failed, setFailed] = useState(false)
  const [at, setAt] = useState(0)
  const [tally, setTally] = useState(NONE)

  const load = useCallback(() => {
    setFailed(false)
    readSweep(200)
      .then((found) => {
        setAnswer(found)
        setAt(0)
        setTally(NONE)
      })
      .catch(() => setFailed(true))
  }, [])
  useEffect(load, [load])

  const tasks = answer?.tasks ?? []
  // Passed over: what was done, binned or moved out of sight meanwhile.
  const open = (task: SweepTask) => {
    const r = view.reminder(task.id)
    return !!r && !r.completed_at && !view.inTrash(r)
  }
  const pos = sync.loaded ? tasks.findIndex((task, index) => index >= at && open(task)) : -1
  const task = pos >= 0 ? tasks[pos] : null
  const reminder = task ? view.reminder(task.id) : undefined
  const finished = !!answer && sync.loaded && !task

  const act = (choice: Choice) => {
    if (!task || !reminder) return
    if (choice === 'parked' && reminder.repeat) return
    if (choice === 'kept') void keepTask(task.id).catch(() => undefined)
    if (choice === 'moved') engine.put('reminder', reminder.id, dueChange(reminder, addDays(today, 7), reminder.due_time))
    if (choice === 'parked') engine.put('reminder', reminder.id, dueChange(reminder, null, null))
    if (choice === 'dropped') trashReminder(engine, reminder, (title) => t('sweep.binned', { title }))
    setTally((before) => ({ ...before, [choice]: before[choice] + 1 }))
    setAt(pos + 1)
  }

  // The keys act before the page's own (N is "new task" elsewhere), and only when nothing else has the focus.
  const latest = useRef(act)
  useEffect(() => {
    latest.current = act
  })
  const keys = { keep: t('sweep.keyKeep').toLowerCase(), next: t('sweep.keyNext').toLowerCase(), someday: t('sweep.keySomeday').toLowerCase() }
  const keyList = `${keys.keep}|${keys.next}|${keys.someday}`
  useEffect(() => {
    const [keep, next, someday] = keyList.split('|')
    const listen = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || document.querySelector('[role="dialog"]')) return
      const key = event.key.toLowerCase()
      const choice: Choice | null = key === keep ? 'kept' : key === next ? 'moved' : key === someday ? 'parked' : event.key === 'Delete' || event.key === 'Backspace' ? 'dropped' : null
      if (!choice) return
      event.preventDefault()
      event.stopPropagation()
      latest.current(choice)
    }
    window.addEventListener('keydown', listen, true)
    return () => window.removeEventListener('keydown', listen, true)
  }, [keyList])

  const seen = Object.values(tally).reduce((a, b) => a + b, 0)
  const list = reminder ? view.list(reminder.list_id) : undefined
  const space = list ? view.space(list.space_id) : undefined
  const shared = reminder ? isSharedList(view, reminder.list_id) : false

  const buttons: { choice: Choice; icon: LucideIcon; label: string; key: string; disabled?: boolean; hint?: string; tone?: string }[] = [
    { choice: 'kept', icon: Bookmark, label: t('sweep.keep'), key: t('sweep.keyKeep') },
    { choice: 'moved', icon: CalendarClock, label: t('sweep.nextWeek'), key: t('sweep.keyNext') },
    { choice: 'parked', icon: CalendarOff, label: t('sweep.someday'), key: t('sweep.keySomeday'), disabled: !!reminder?.repeat, hint: reminder?.repeat ? t('sweep.repeatSomeday') : undefined },
    { choice: 'dropped', icon: Trash2, label: t('sweep.drop'), key: t('keys.del'), tone: 'hover:text-bad-500' },
  ]

  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="sweep-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="sweep-title" title={t('sweep.title')} count={task ? t('sweep.step', { at: pos + 1, total: tasks.length }) : undefined} sub={t('sweep.sub')} icon={<TileIcon icon={SWEEP_ICON} />} newTask={false} />
        <div className="nt-read space-y-4">
          {failed && (
            <QuietEmpty icon={SWEEP_ICON} title={t('sweep.failed')}>
              <button type="button" className="nt-btn nt-btn-ghost mt-3" onClick={load}>
                {t('sweep.again')}
              </button>
            </QuietEmpty>
          )}
          {task && reminder && (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={pos} aria-label={t('sweep.step', { at: pos + 1, total: tasks.length })}>
                <span className="block h-full rounded-full bg-petrol transition-[width]" style={{ width: `${(pos / tasks.length) * 100}%` }} />
              </div>
              <article className="nt-group px-5 pt-4 pb-5 sm:px-6" aria-label={reminder.title} data-testid="sweep-card">
                <div className="flex items-center gap-2 text-[12.5px] text-mist-500">
                  {list && <Plaque color={list.color} icon={list.icon} size={18} />}
                  <span className="min-w-0 truncate font-semibold text-mist-300">{list?.name}</span>
                  {space && <span className="min-w-0 truncate">· {space.name}</span>}
                  <span className="ml-auto shrink-0 font-semibold text-mist-300" data-testid="sweep-age">
                    {t('sweep.age', { count: task.age_days })}
                  </span>
                </div>
                <button type="button" className="mt-3 block w-full text-left text-[21px] leading-snug font-bold text-mist-100 hover:text-accent-400" onClick={() => shell.openReminder(reminder.id)}>
                  {reminder.title}
                </button>
                <p className="mt-2 text-[13px] text-mist-500">
                  {t('sweep.changed', { day: shortDate(addDays(today, -task.unchanged_days), i18n.language) })}
                  {' · '}
                  {reminder.due_date ? (
                    <span className={reminder.due_date < today ? 'font-semibold text-late' : undefined}>
                      {t('sweep.due', { day: shortDate(reminder.due_date, i18n.language) })}
                      {reminder.due_date < today && ` · ${t('sweep.late', { count: Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${reminder.due_date}T12:00:00Z`)) / 86_400_000) })}`}
                    </span>
                  ) : (
                    t('sweep.noDue')
                  )}
                  {reminder.repeat && ` · ${t('sweep.repeats')}`}
                </p>
                {shared && reminder.assignees.length > 0 && (
                  <div className="mt-2">
                    <AvatarStack ids={reminder.assignees} people={view.people} max={4} />
                  </div>
                )}
                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {buttons.map(({ choice, icon: Icon, label, key, disabled, hint, tone }) => (
                    <button
                      key={choice}
                      type="button"
                      disabled={disabled}
                      title={hint ?? `${label} (${key})`}
                      onClick={() => act(choice)}
                      className={'nt-btn nt-btn-ghost h-auto min-h-[44px] flex-col gap-0.5 py-1.5 ' + (tone ?? '')}
                      data-testid={`sweep-${choice}`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon className="h-4 w-4" strokeWidth={1.9} aria-hidden /> {label}
                      </span>
                      <kbd className="max-md:hidden">{key}</kbd>
                    </button>
                  ))}
                </div>
              </article>
              <p className="px-1 text-xs text-mist-500 max-md:hidden">{t('sweep.keys')}</p>
            </>
          )}
          {finished && (seen === 0 ? <QuietEmpty icon={SWEEP_ICON} title={t('sweep.empty')} text={t('sweep.emptyLine')} /> : <Summary tally={tally} seen={seen} />)}
        </div>
      </div>
    </main>
  )
}

function Summary({ tally, seen }: { tally: Record<Choice, number>; seen: number }) {
  const { t } = useTranslation()
  const parts = (Object.keys(tally) as Choice[]).filter((choice) => tally[choice]).map((choice) => t(`sweep.${choice}`, { count: tally[choice] }))
  return (
    <div className="nt-group px-5 py-5 sm:px-6" data-testid="sweep-summary">
      <h2 className="text-[17px] font-bold text-mist-100">{t('sweep.doneTitle')}</h2>
      <p className="mt-1.5 text-sm text-mist-300">
        {t('sweep.summary', { count: seen })} {parts.join(' · ')}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/all" className="nt-btn nt-btn-accent">
          {t('sweep.back')} <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        {tally.parked > 0 && (
          <Link to="/someday" className="nt-btn nt-btn-ghost">
            <SOMEDAY_ICON className="h-4 w-4" aria-hidden /> {t('someday.title')}
          </Link>
        )}
      </div>
    </div>
  )
}
