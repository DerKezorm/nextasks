/**
 * "Today" as a page of the day (concept, draft 1; alone: draft 4). On top the week band of the next seven days. On the
 * left three cards: overdue (with "All to today"), the ones with a time as a timeline with the line of now, and those
 * for some time today with the quick entry below; what was ticked off today stays there, ticked, until the next day.
 * On the right, from about 1400 px (below the cards on narrower windows): how far the day got, the focus of the day,
 * the family's day where others share a space or "Your week" alone, and tomorrow. "Plan tomorrow" in the head deals
 * with what stayed open. Nothing left open: a quiet card with the run of days and what tomorrow brings.
 */
import { CalendarClock, CircleCheck, Clock, Sun } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CardHead } from '../components/CardHead'
import { PageHead } from '../components/PageHead'
import { PlanTomorrow } from '../components/PlanTomorrow'
import { QuickEntry } from '../components/QuickEntry'
import { ReminderGroup, type RowExtras } from '../components/ReminderRow'
import { FamilyCard, FocusCard, ProgressCard, TomorrowCard, WeekBand, WeekCard } from '../components/TodayParts'
import { dueChange, moveToDay } from '../lib/actions'
import { localDay, localTime, longDay } from '../lib/due'
import { FocusProvider, useFocusState } from '../lib/focus'
import { showNotice } from '../lib/notice'
import { isAlone, isSharedList } from '../lib/shared'
import { dueOn, focusTask, fromNow, nowIndex, progressOf, todayCards, topRows, weekBand } from '../lib/today'
import { lastWeek, useTodayStats } from '../lib/todayStats'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { personName } from '../components/People'

/** The time now, a new one every half minute: the line of now moves, and past midnight the page turns to the next day. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** The line of now in the timeline: the time in red and a red line with a dot. */
function NowLine({ time }: { time: string }) {
  return (
    <div className="grid h-3.5 grid-cols-[46px_minmax(0,1fr)] items-center gap-[11px] px-3" data-nowline data-testid="now-line" aria-hidden>
      <span className="text-[10.5px] font-bold text-late tabular-nums">{time}</span>
      <i className="relative h-0.5 rounded-[1px] bg-late before:absolute before:-top-[3px] before:-left-1 before:h-2 before:w-2 before:rounded-full before:bg-late" />
    </div>
  )
}

export function TodayPage() {
  const { t, i18n } = useTranslation()
  const view = useView()
  const engine = useEngine()
  const now = useNow()
  const today = localDay(now)
  const time = localTime(now)
  const tomorrow = addDays(today, 1)
  const focus = useFocusState(today)
  const [planning, setPlanning] = useState(false)

  const cards = todayCards(view, today)
  const progress = progressOf(cards)
  const only = new Set(cards.all.map((r) => r.id))
  const band = weekBand(view, today)
  const coming = dueOn(view, tomorrow)
  const alone = isAlone(view)
  // The column is read again once the day on the page changed.
  const signature = `${today}:${cards.all.map((r) => (r.completed_at ? 'x' : 'o') + r.id.slice(0, 4)).join('')}`
  const stats = useTodayStats(signature)
  const streak = stats ? stats.streak.current : null

  const visible = useMemo(() => new Set(view.visible.map((r) => r.id)), [view])
  const focused = focus.ids.map((id) => focusTask(view, id, today, visible)).filter((r): r is Reminder => !!r)

  const first = view.defaultList
  const target = first ? { spot: { list_id: first.id, section_id: null, parent_id: null }, defaults: { due_date: today, due_time: null, repeat: null, repeat_from: 'due' as const } } : null

  /** "done by Leo, 11:20" (only where others share the list), "done at 11:20" alone. */
  const doneMeta = (reminder: Reminder): ReactNode => {
    const at = localTime(new Date(reminder.completed_at!))
    const by = reminder.completed_by !== null && isSharedList(view, reminder.list_id) ? personName(view.people.get(reminder.completed_by), t) : null
    return <span data-testid="done-by">{by ? t('today.doneBy', { name: by, time: at }) : t('today.doneAt', { time: at })}</span>
  }
  const plain = (reminder: Reminder): RowExtras | undefined => (reminder.completed_at ? { meta: doneMeta(reminder), hideDue: true } : undefined)
  const anytime = (reminder: Reminder): RowExtras => (reminder.completed_at ? { meta: doneMeta(reminder), hideDue: true } : { hideDue: true })
  const timed = (reminder: Reminder): RowExtras => {
    const lead = <span className={'w-[46px] shrink-0 pt-px text-[12.5px] font-semibold tabular-nums ' + (!reminder.completed_at && reminder.due_time! > time ? 'text-accent-400' : 'text-mist-500')}>{reminder.due_time}</span>
    if (reminder.completed_at) return { lead, meta: doneMeta(reminder), hideDue: true }
    const away = fromNow(reminder.due_time!, time)
    return {
      lead,
      hideDue: true,
      meta: (
        <span className={'inline-flex items-center gap-1 font-semibold ' + (away.late ? 'text-late' : 'text-accent-400')} data-testid="from-now">
          {away.late && <Clock className="h-[13px] w-[13px]" aria-hidden />}
          {t(`today.time.${away.key}`, { n: away.value })}
        </span>
      ),
    }
  }

  const allToToday = () => {
    const late = cards.overdue.filter((r) => !r.completed_at)
    const before = late.map((r) => ({ reminder: r, day: r.due_date! }))
    for (const r of late) moveToDay(engine, r, today)
    showNotice({
      text: t('today.movedToToday', { count: late.length }),
      undo: () => {
        for (const { reminder, day } of before) {
          const current = view.reminder(reminder.id)
          if (current && !current.completed_at) engine.put('reminder', current.id, dueChange(current, day, current.due_time))
        }
      },
    })
  }

  const overdueOpen = cards.overdue.filter((r) => !r.completed_at).length
  const timedTops = topRows(cards.timed, cards.all)
  const nowAt = nowIndex(timedTops, time)
  const quick = <QuickEntry spot={null} defaults={{ due_date: today, due_time: null, repeat: null, repeat_from: 'due' }} label={t('today.quick', { list: first?.name ?? '' })} />

  const left = (
    <div className="flex min-w-0 flex-col gap-4">
      {cards.open === 0 && (
        <section className="nt-group flex items-start gap-3.5 px-4 py-4" data-testid="today-calm">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-accent-wash text-accent-400">
            <CircleCheck className="h-5 w-5" strokeWidth={1.9} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="font-semibold text-mist-100">{t('tiles.empty.today')}</h2>
            <p className="text-sm text-mist-500">
              {[streak ? t('today.calm.streak', { count: streak }) : '', coming.length ? t('tiles.tomorrow', { count: coming.length }) : t('tiles.tomorrowNone')].filter(Boolean).join(' ')}
            </p>
            {coming.length > 0 && <p className="mt-1 truncate text-sm text-mist-300">{coming.slice(0, 3).map((r) => (r.due_time ? `${r.due_time} ${r.title}` : r.title)).join(' · ')}</p>}
          </div>
        </section>
      )}
      {cards.overdue.length > 0 && (
        <section aria-label={t('tiles.overdue')} data-testid="card-overdue">
          <ReminderGroup
            spot={null}
            items={topRows(cards.overdue, cards.all)}
            showDone
            showList
            only={only}
            decorate={plain}
            head={
              <CardHead
                tone="late"
                count={overdueOpen}
                action={
                  overdueOpen > 0 && (
                    <button type="button" className="rounded-md px-2 py-1 text-[12.5px] font-semibold text-accent-400 hover:bg-ink-800" onClick={allToToday} data-testid="all-to-today">
                      {t('today.allToToday')}
                    </button>
                  )
                }
              >
                <Clock className="h-3.5 w-3.5 self-center" strokeWidth={2.4} aria-hidden />
                {t('tiles.overdue')}
              </CardHead>
            }
          />
        </section>
      )}
      {cards.timed.length > 0 && (
        <section aria-label={t('today.timed')} data-testid="card-timed">
          <ReminderGroup
            spot={null}
            items={timedTops}
            showDone
            showList
            only={only}
            decorate={timed}
            between={(index) => (index === nowAt ? <NowLine time={time} /> : null)}
            head={<CardHead count={cards.timed.filter((r) => !r.completed_at).length}>{t('today.timed')}</CardHead>}
          />
        </section>
      )}
      <section aria-label={t('today.anytime')} data-testid="card-anytime">
        <ReminderGroup spot={null} items={topRows(cards.anytime, cards.all)} showDone showList only={only} decorate={anytime} footer={quick} head={<CardHead count={cards.anytime.filter((r) => !r.completed_at).length}>{t('today.anytime')}</CardHead>} />
      </section>
    </div>
  )

  const rail = (
    <div className="grid min-w-0 content-start items-start gap-3.5 sm:max-[1399px]:grid-cols-2" data-testid="today-rail">
      <ProgressCard due={progress.due} done={progress.done} overdue={progress.overdue} streak={streak} />
      {focus.ready && <FocusCard focus={focus} items={focused} />}
      {!alone && stats && <FamilyCard stats={stats} />}
      {alone && stats && <WeekCard days={lastWeek(stats)} today={today} streak={streak} />}
      <TomorrowCard items={coming} tomorrow={tomorrow} />
    </div>
  )

  return (
    <FocusProvider value={focus}>
      <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="tile-title">
        <div className="px-4 py-5 sm:px-7 sm:py-6">
          <PageHead
            id="tile-title"
            target={target}
            title={t('tiles.today')}
            count={t('list.open', { count: cards.open })}
            sub={t('today.sub', { day: longDay(today, i18n.language) })}
            icon={
              <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] bg-petrol text-white" data-plaque>
                <Sun className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />
              </span>
            }
          >
            <button type="button" className="nt-btn nt-btn-ghost h-8 px-3" onClick={() => setPlanning(true)} aria-label={t('today.plan.open')} data-testid="plan-tomorrow-open">
              <CalendarClock className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline" aria-hidden>
                {t('today.plan.open')}
              </span>
            </button>
          </PageHead>
          <div className="max-w-[1262px]">
            <WeekBand days={band} today={today} />
            <div className="grid items-start gap-[22px] min-[1400px]:grid-cols-[minmax(0,1fr)_320px]">
              {left}
              {rail}
            </div>
          </div>
        </div>
        {planning && <PlanTomorrow onClose={() => setPlanning(false)} />}
      </main>
    </FocusProvider>
  )
}
