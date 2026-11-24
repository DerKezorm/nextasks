/**
 * The review (concept "Rückblick"): what got done, from the record of completions (`GET /api/stats`). In the head a
 * petrol plaque, the title, where the numbers come from and when, on the right the period (week, month, year) and the
 * place (all spaces or one); both stand in the address (`?range=`, `?space=`). Below: four numbers (done with the
 * change and a small line, the streak, on time, open on average), a year of days as a heat map, who took on what
 * (or, alone, the lists and the records), when things get done, the pulse of repeating tasks and the week in the
 * server's sentences. Alone (nobody else in the places counted) the family parts stay away and the words speak to
 * one person. From December to January a card at the top leads to "Your year". Nothing done yet: a quiet empty
 * state instead of empty pictures. On a phone everything stands one below the other; the heat map scrolls sideways.
 */
import { BarChart3, ChevronRight, Sparkles } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { EmptyState } from '../components/EmptyState'
import { BackToOverview } from '../components/PageHead'
import { HeatLegend, HeatMap, ListShares, Pulse, PulseLegend, Punchcard, RecordsBlock, ReviewCard, Spark, WhoBars } from '../components/ReviewCharts'
import { localDay } from '../lib/due'
import { errorText } from '../lib/errors'
import { count, decimal, hourName, listName, monthYear, peakOf, PERIODS, shortDay, sparkOf, useStats, weekdayName, yearOffered, dayMonth, type Period, type Stats } from '../lib/stats'
import { useView } from '../state/sync'

/** The petrol plaque of the review: its symbol in white, as a list's plaque in its head. */
export function ReviewPlaque({ size = 30 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center bg-petrol" style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }} aria-hidden>
      <BarChart3 className="text-white" style={{ width: size * 0.58, height: size * 0.58 }} strokeWidth={2.3} />
    </span>
  )
}

function periodOf(value: string | null): Period {
  return PERIODS.includes(value as Period) ? (value as Period) : 'month'
}

export function ReviewPage() {
  const { t, i18n } = useTranslation()
  const view = useView()
  const [params, setParams] = useSearchParams()
  const period = periodOf(params.get('range'))
  const wanted = params.get('space') ?? 'all'
  const spaces = view.spaces
  const space = wanted === 'all' || spaces.some((s) => s.id === wanted) ? wanted : 'all'
  const load = useStats(space, period)
  const choose = (name: 'range' | 'space', value: string) =>
    setParams(
      (now) => {
        const next = new URLSearchParams(now)
        next.set(name, value)
        return next
      },
      { replace: true },
    )

  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="review-title">
      <div className="flex max-w-[1280px] flex-col gap-4 px-4 py-5 sm:px-7 sm:py-6" data-testid="review-page">
        <header className="-mx-1 border-b border-ink-700 bg-ink-950 px-1 pt-1 pb-3 md:sticky md:top-0 md:z-10" data-testid="page-head">
          <BackToOverview />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <ReviewPlaque />
              <div className="min-w-0">
                <h1 id="review-title" className="truncate text-[22px] font-bold tracking-[-0.01em] text-mist-100">
                  {t('review.title')}
                </h1>
                <p className="truncate text-[12px] text-mist-600" data-testid="review-sub">
                  {load.state === 'ready' ? subOf(load.stats, t, i18n.language) : ' '}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 max-md:w-full">
              <div className="flex rounded-[9px] border border-ink-700 bg-ink-850 p-[3px] max-md:flex-1" role="radiogroup" aria-label={t('review.period')} data-testid="review-period">
                {PERIODS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={period === p}
                    onClick={() => choose('range', p)}
                    className={'flex-1 rounded-[7px] px-3 py-[5px] text-[13px] ' + (period === p ? 'nt-chosen font-semibold' : 'text-mist-500 hover:text-mist-100')}
                  >
                    {t(`review.periods.${p}`)}
                  </button>
                ))}
              </div>
              <select aria-label={t('review.place')} className="nt-field h-[36px] w-auto max-w-[220px] px-2 max-md:flex-1" value={space} onChange={(e) => choose('space', e.target.value)} data-testid="review-space">
                <option value="all">{t('review.allSpaces')}</option>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </header>

        {load.state === 'loading' && (
          <p className="text-sm text-mist-500" role="status">
            {t('review.loading')}
          </p>
        )}
        {load.state === 'failed' && (
          <p className="nt-problem" role="alert">
            {errorText(load.code)}
          </p>
        )}
        {load.state === 'ready' && <ReviewBody stats={load.stats} period={period} />}
      </div>
    </main>
  )
}

type T = ReturnType<typeof useTranslation>['t']

/** "Familie · 6 Mitglieder · Stand heute 12:40", or for all spaces how many there are. */
function subOf(stats: Stats, t: T, language: string): string {
  const { scope } = stats
  const time = new Date(scope.as_of).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const only = scope.space !== 'all' ? scope.spaces.find((s) => s.id === scope.space) : undefined
  const place = only
    ? `${only.name} · ${only.members > 1 ? t('review.members', { count: only.members }) : t('review.onlyYou')}`
    : `${t('review.allSpaces')} · ${t('review.spaces', { count: scope.spaces.length })}`
  return `${place} · ${t('review.asOf', { time })}`
}

function ReviewBody({ stats, period }: { stats: Stats; period: Period }) {
  const { t } = useTranslation()
  const alone = stats.scope.alone
  const offered = yearOffered(localDay())
  const teaser = offered !== null && <YearTeaser year={offered} alone={alone} />
  if (!stats.records.total)
    return (
      <>
        {teaser}
        <EmptyState icon={BarChart3} title={t('review.empty')} text={t(alone ? 'review.emptyTextAlone' : 'review.emptyText')} />
      </>
    )
  return (
    <>
      {teaser}
      <Numbers stats={stats} period={period} />
      <HeatCard stats={stats} />
      {alone ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <ReviewCard title={t('review.records')} sub={t('review.recordsSub')} testid="records-card">
              <RecordsBlock records={stats.records} />
            </ReviewCard>
            <ReviewCard title={t('review.lists')} sub={t(`review.periodSub.${period}`)} testid="lists-card">
              {stats.lists.length ? <ListShares lists={stats.lists} /> : <Quiet>{t('review.nothingHere')}</Quiet>}
            </ReviewCard>
          </div>
          <WhenCard stats={stats} />
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <ReviewCard title={t('review.who')} sub={`${t(`review.periodSub.${period}`)} · ${t('review.whoSub')}`} testid="who-card">
            {stats.by_person.length ? <WhoBars stats={stats} /> : <Quiet>{t('review.nothingHere')}</Quiet>}
          </ReviewCard>
          <WhenCard stats={stats} />
        </div>
      )}
      <ReviewCard title={t('review.pulse')} sub={t(alone ? 'review.pulseSubAlone' : 'review.pulseSub')} right={stats.pulse.length ? <PulseLegend /> : undefined} testid="pulse-card">
        {stats.pulse.length ? <Pulse pulse={stats.pulse} people={stats.people} alone={alone} /> : <Quiet>{t('review.pulseNone')}</Quiet>}
      </ReviewCard>
      <WeekCard stats={stats} />
    </>
  )
}

/** A quiet line where a card has nothing to show. */
function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-2 text-[13px] text-mist-500">{children}</p>
}

function Kpi({ label, value, line, up, children, testid }: { label: string; value: string; line: string; up?: boolean; children?: ReactNode; testid: string }) {
  return (
    <div className="nt-card flex min-w-0 flex-col gap-0.5 px-4 py-3.5" data-testid={testid}>
      <small className="text-[12px] font-semibold text-mist-600">{label}</small>
      <b className="text-[28px] leading-tight font-extrabold tracking-[-0.02em] text-mist-100 tabular-nums">{value}</b>
      <span className={'text-[12px] ' + (up ? 'font-semibold text-ok-500' : 'text-mist-600')}>{line}</span>
      {children}
    </div>
  )
}

/** The four numbers on top. */
function Numbers({ stats, period }: { stats: Stats; period: Period }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { total, streak, punctuality, duration } = stats
  const change = total.change_pct
  const changeText =
    change === null ? t('review.noBefore') : t(`review.change.${period}`, { change: (change > 0 ? '+' : change < 0 ? '−' : '±') + (Math.abs(change) / 100).toLocaleString(lang, { style: 'percent', maximumFractionDigits: 0 }) })
  const quickest = duration.lists[0]
  const days = (n: number) => t('review.openDays', { count: n, days: decimal(n, lang) })
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="review-numbers">
      <Kpi testid="kpi-done" label={t(`review.done.${period}`)} value={count(total.count, lang)} line={changeText} up={change !== null && change > 0}>
        <Spark values={sparkOf(stats.heatmap.days, period)} label={t(`review.spark.${period}`)} />
      </Kpi>
      <Kpi
        testid="kpi-streak"
        label={t('review.streak')}
        value={t('review.streakDays', { count: streak.current })}
        line={t(!streak.current ? 'review.streakNone' : streak.done_today ? 'review.streakHint' : 'review.streakKeep', { record: count(streak.record, lang) })}
      />
      <Kpi
        testid="kpi-ontime"
        label={t('review.onTime')}
        value={punctuality.percent === null ? '–' : (punctuality.percent / 100).toLocaleString(lang, { style: 'percent', maximumFractionDigits: 0 })}
        line={t(punctuality.percent === null ? 'review.onTimeNone' : 'review.onTimeHint')}
      />
      <Kpi
        testid="kpi-open"
        label={t('review.openAvg')}
        value={duration.average_days === null ? '–' : days(duration.average_days)}
        line={duration.average_days === null ? t('review.openNone') : quickest && duration.lists.length > 1 ? t('review.openHintList', { list: listName(quickest.list, t), days: decimal(quickest.average_days, lang) }) : t('review.openHint')}
      />
    </div>
  )
}

function HeatCard({ stats }: { stats: Stats }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { heatmap } = stats
  const span = t('review.span', { from: monthYear(heatmap.from, lang), to: monthYear(heatmap.to, lang) })
  const best = heatmap.best ? ' · ' + t('review.heatBest', { day: shortDay(heatmap.best.date, lang), count: heatmap.best.count }) : ''
  return (
    <ReviewCard title={t('review.heat')} sub={span + best} right={<HeatLegend />} testid="heat-card">
      <HeatMap from={heatmap.from} days={heatmap.days} today={stats.scope.today} label={t('review.heatLabel')} />
    </ReviewCard>
  )
}

function WhenCard({ stats }: { stats: Stats }) {
  const { t, i18n } = useTranslation()
  const peak = peakOf(stats.hours)
  return (
    <ReviewCard title={t('review.when')} sub={t('review.whenSub')} testid="when-card">
      {peak ? (
        <>
          <Punchcard hours={stats.hours} />
          <p className="text-[12px] text-mist-600" data-testid="when-peak">
            {t('review.whenPeak', { weekday: weekdayName(peak.weekday, i18n.language, 'long'), hour: hourName(peak.hour, i18n.language) })}
          </p>
        </>
      ) : (
        <Quiet>{t('review.nothingHere')}</Quiet>
      )}
    </ReviewCard>
  )
}

function WeekCard({ stats }: { stats: Stats }) {
  const { t, i18n } = useTranslation()
  const { week } = stats
  if (!week.sentences.length) return null
  return (
    <section className="nt-card flex flex-col gap-3 px-4 py-4 sm:px-[18px]" style={{ background: 'linear-gradient(135deg, var(--color-accent-wash), var(--color-ink-850) 70%)' }} aria-label={t('review.week')} data-testid="week-card">
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <h2 className="text-[14px] font-bold text-mist-100">{t('review.week')}</h2>
        <span className="text-[12.5px] text-mist-600">{t('review.span', { from: dayMonth(week.from, i18n.language), to: dayMonth(week.to, i18n.language) })}</span>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-[18px] text-[14px] text-mist-200 marker:text-accent-400">
        {week.sentences.map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
      </ul>
    </section>
  )
}

/** December and January: the year's card waits, a click away. */
function YearTeaser({ year, alone }: { year: number; alone: boolean }) {
  const { t } = useTranslation()
  return (
    <Link
      to={`/review/year/${year}`}
      className="nt-card group flex items-center gap-3.5 px-4 py-3.5 hover:border-accent-500"
      style={{ background: 'linear-gradient(160deg, var(--color-accent-wash), var(--color-ink-850) 75%)' }}
      data-testid="year-teaser"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-accent-wash text-accent-400">
        <Sparkles className="h-5 w-5" strokeWidth={2} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-extrabold tracking-[0.1em] text-accent-400 uppercase">{t('review.yearEntry', { year })}</span>
        <span className="text-[13px] text-mist-500">{t(alone ? 'review.yearTeaserAlone' : 'review.yearTeaser')}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[13px] font-semibold text-accent-400">
        {t('review.yearOpen')}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </Link>
  )
}
