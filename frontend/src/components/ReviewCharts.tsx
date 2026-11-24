/**
 * The pictures of the review (concept "Rückblick"): the heat map of a year of days, the small line of "Done", the
 * stacked bars of who took over what, the dots of when things get done, the pulse of repeating tasks, the shares of the
 * lists and the records. All drawn here as SVG or plain boxes, to scale, in the petrol steps of the theme
 * (`--color-heat-0` … `-4`); the colours of lists only as small marks and bar parts. Each one measures the room it
 * has, so its words keep their size on any width; the heat map scrolls sideways where the room is too small.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { colorOf } from '../lib/look'
import {
  count as fmt,
  gridOf,
  heat,
  heatSteps,
  isoWeek,
  listName,
  hourName,
  monthColumns,
  monthName,
  niceTicks,
  pulseRate,
  shiftDay,
  shortDay,
  weekdayName,
  type ListBrief,
  type Records,
  type Series,
  type Stats,
  type StatsPerson,
  useWidth,
} from '../lib/stats'
import { describeRule } from '../lib/due'

const AXIS = { fontSize: 10.5, fill: 'var(--color-mist-600)' }

/** A card of the review: its title, a small grey line after it, room on the right (a legend), the content. */
export function ReviewCard({ title, sub, right, children, className = '', testid }: { title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; testid?: string }) {
  return (
    <section className={'nt-card flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-[18px] ' + className} aria-label={title} data-testid={testid}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-[14px] font-bold text-mist-100">{title}</h2>
        {sub && <span className="text-[12.5px] text-mist-600">{sub}</span>}
        {right && <span className="ml-auto flex items-center">{right}</span>}
      </div>
      {children}
    </section>
  )
}

/** "less ▢▢▢▢▢ more". */
export function HeatLegend() {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-mist-600" data-testid="heat-legend">
      {t('review.less')}
      {[0, 1, 2, 3, 4].map((step) => (
        <i key={step} className="inline-block h-[11px] w-[11px] rounded-[3px]" style={{ background: heat(step) }} aria-hidden />
      ))}
      {t('review.more')}
    </span>
  )
}

/**
 * The heat map: one square per day in weeks of seven (Monday on top), the month above its first full week, Monday,
 * Wednesday, Friday and Sunday on the left, today with a ring. The squares grow with the room up to 18 px and stay
 * at least 10 px; below that the map scrolls sideways and starts at its end (today).
 */
export function HeatMap({ from, days, today, label }: { from: string; days: number[]; today: string; label: string }) {
  const { t, i18n } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box, 900)
  const { lead, columns } = gridOf(from, days.length)
  const left = 30
  const top = 18
  const gap = 3
  const cell = Math.max(10, Math.min(18, Math.floor((width - left) / columns) - gap))
  const step = cell + gap
  const full = left + columns * step
  const height = top + 7 * step
  const steps = heatSteps(days)
  // Start at today where the map is wider than its room.
  useLayoutEffect(() => {
    const node = box.current
    if (node) node.scrollLeft = node.scrollWidth
  }, [full])
  return (
    <div ref={box} className="nt-scroll -mx-1 overflow-x-auto px-1 pb-1" data-testid="heat-scroll">
      <svg width={full} height={height} role="img" aria-label={label} data-testid="heatmap" className="block">
        {monthColumns(from, days.length).map(({ column, day }) => (
          <text key={day} x={left + column * step} y={11} {...AXIS}>
            {monthName(Number(day.slice(5, 7)), i18n.language, 'short')}
          </text>
        ))}
        {[0, 2, 4, 6].map((row) => (
          <text key={row} x={0} y={top + row * step + cell * 0.75} {...AXIS}>
            {weekdayName(row, i18n.language)}
          </text>
        ))}
        {days.map((n, i) => {
          const day = shiftDay(from, i)
          const column = Math.floor((lead + i) / 7)
          const row = (lead + i) % 7
          const isToday = day === today
          return (
            <rect
              key={day}
              x={left + column * step}
              y={top + row * step}
              width={cell}
              height={cell}
              rx={3}
              fill={heat(steps[i])}
              stroke={isToday ? 'var(--color-mist-100)' : undefined}
              strokeWidth={isToday ? 1.5 : undefined}
              data-day={day}
              data-count={n}
              data-step={steps[i]}
            >
              <title>{(isToday ? t('review.heatToday') + ', ' : '') + t('review.heatDay', { count: n, day: shortDay(day, i18n.language, true) })}</title>
            </rect>
          )
        })}
      </svg>
    </div>
  )
}

/** The small line under "Done": the area in the accent's wash, the line in petrol, the last point as a dot. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  const w = 200
  const h = 34
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const points = values.map((v, i) => [2 + (i / (values.length - 1)) * (w - 4), h - 3 - (v / max) * (h - 8)] as const)
  const line = 'M' + points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')
  const [lx, ly] = points[points.length - 1]
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label} className="mt-1 block" data-testid="spark">
      <path d={`${line} L${w - 2},${h} L2,${h} Z`} fill="var(--color-accent-wash)" />
      <path d={line} fill="none" stroke="var(--color-petrol)" strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r={2.6} fill="var(--color-petrol)" />
    </svg>
  )
}

/** The small square of a list's colour (docs "Aussehen", principle 2: where there is no room for a plaque). */
export function ListSquare({ list }: { list: ListBrief | undefined }) {
  return <i className="inline-block h-[10px] w-[10px] shrink-0 rounded-[3px]" style={{ background: list?.color ? colorOf(list.color) : 'var(--color-ink-600)' }} aria-hidden />
}

/** How many lists the stacked bars name; the rest go together as "Other lists". */
const SHOWN_LISTS = 6

/**
 * Who took over what: per person a bar of their done tasks, its parts by list in the lists' colours, the sum after
 * it, on an axis of round steps from 0. Below, the lists as a legend.
 */
export function WhoBars({ stats }: { stats: Stats }) {
  const { t, i18n } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box, 520)
  const shown = stats.lists.slice(0, SHOWN_LISTS)
  const shownIds = new Set(shown.map((entry) => entry.list.id))
  const rest = stats.lists.length > SHOWN_LISTS
  const nameOf = (id: number | null) => stats.people.find((p) => p.id === id)?.name ?? ''
  const rows = stats.by_person.map((person) => {
    const parts = shown.map((entry) => ({ key: entry.list.id, list: entry.list as ListBrief | undefined, count: person.lists.find((l) => l.list_id === entry.list.id)?.count ?? 0 }))
    const other = person.lists.filter((l) => !shownIds.has(l.list_id)).reduce((a, l) => a + l.count, 0)
    if (other) parts.push({ key: 'other', list: undefined, count: other })
    return { id: person.id, name: nameOf(person.id), total: person.count, parts: parts.filter((p) => p.count > 0) }
  })
  const left = Math.min(110, Math.max(70, width * 0.2))
  const right = 40
  const rowH = 33
  const ticks = niceTicks(Math.max(...rows.map((r) => r.total), 1))
  const topTick = ticks[ticks.length - 1]
  const scale = (width - left - right) / topTick
  const height = rows.length * rowH + 26
  return (
    <div ref={box} className="flex flex-col gap-3">
      <svg width={width} height={height} role="img" aria-label={t('review.whoLabel')} data-testid="who-bars" className="block">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left + v * scale} x2={left + v * scale} y1={2} y2={height - 20} stroke="var(--color-ink-700)" strokeWidth={1} />
            <text x={left + v * scale} y={height - 6} textAnchor="middle" {...AXIS}>
              {fmt(v, i18n.language)}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const y = 6 + i * rowH
          let x = left
          return (
            <g key={row.id ?? 'former'} data-person={row.id ?? 'former'}>
              <text x={0} y={y + 14.5} fontSize={12.5} fill="var(--color-mist-100)">
                {clip(row.name, left - 8, 12.5)}
              </text>
              {row.parts.map((part) => {
                const w = part.count * scale
                const rect = (
                  <rect key={part.key} x={x} y={y} width={Math.max(w - 1.5, 1)} height={20} rx={3} fill={part.list?.color ? colorOf(part.list.color) : 'var(--color-ink-600)'} data-list={part.key} data-count={part.count}>
                    <title>{t('review.whoBar', { name: row.name, list: part.key === 'other' ? t('review.otherLists') : listName(part.list, t), count: part.count })}</title>
                  </rect>
                )
                x += w
                return rect
              })}
              <text x={x + 6} y={y + 14.5} fontSize={11.5} fontWeight={700} fill="var(--color-mist-500)">
                {fmt(row.total, i18n.language)}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-mist-600" data-testid="who-legend">
        {shown.map((entry) => (
          <span key={entry.list.id} className="inline-flex items-center gap-1.5">
            <ListSquare list={entry.list} />
            {listName(entry.list, t)}
          </span>
        ))}
        {rest && (
          <span className="inline-flex items-center gap-1.5">
            <ListSquare list={undefined} />
            {t('review.otherLists')}
          </span>
        )}
      </div>
    </div>
  )
}

/** A name cut to about `room` pixels (a rough measure: half the type's size per letter). */
function clip(text: string, room: number, size: number): string {
  const fits = Math.floor(room / (size * 0.56))
  return text.length > fits ? text.slice(0, Math.max(1, fits - 1)) + '…' : text
}

/**
 * When things get done: a dot per weekday and hour, its area to scale with the number (the biggest fills its cell),
 * stronger where more was done. Hours from 0 to 23 along, Monday on top.
 */
export function Punchcard({ hours }: { hours: number[][] }) {
  const { t, i18n } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box, 520)
  const left = 30
  const right = 8
  const rowH = 28
  const top = 14
  const colW = (width - left - right) / 24
  const max = Math.max(1, ...hours.flat())
  const radius = Math.min(colW, rowH) / 2 - 0.5
  const height = top + 7 * rowH + 8
  const every = width < 420 ? 6 : 3
  return (
    <div ref={box}>
      <svg width={width} height={height} role="img" aria-label={t('review.whenLabel')} data-testid="punchcard" className="block">
        {hours.map((row, weekday) => {
          const y = top + weekday * rowH
          return (
            <g key={weekday}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="var(--color-ink-800)" strokeWidth={1} />
              <text x={0} y={y + 4} fontSize={11.5} fill="var(--color-mist-600)">
                {weekdayName(weekday, i18n.language)}
              </text>
              {row.map((n, hour) =>
                n > 0 ? (
                  <circle key={hour} cx={left + (hour + 0.5) * colW} cy={y} r={Math.max(1.5, radius * Math.sqrt(n / max))} fill="var(--color-petrol)" fillOpacity={0.35 + 0.6 * (n / max)} data-cell={`${weekday}-${hour}`} data-count={n}>
                    <title>{t('review.whenCell', { weekday: weekdayName(weekday, i18n.language, 'long'), hour: hourName(hour, i18n.language), count: n })}</title>
                  </circle>
                ) : null,
              )}
            </g>
          )
        })}
        {Array.from({ length: 24 / every }, (_, k) => k * every).map((hour) => (
          <text key={hour} x={left + hour * colW} y={height - 1} textAnchor="middle" {...AXIS}>
            {hour}
          </text>
        ))}
      </svg>
    </div>
  )
}

/** The look of a term of a series: done on time, late, or passed over. */
const SLOT_LOOK: Record<string, { background: string; border?: string }> = {
  on_time: { background: 'var(--color-on-time)' },
  late: { background: 'var(--color-done-late)' },
  skipped: { background: 'var(--color-heat-0)', border: '1px solid var(--color-ink-600)' },
}

/** "pünktlich ■ verspätet ■ ausgelassen ■". */
export function PulseLegend() {
  const { t } = useTranslation()
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-mist-600">
      {(['on_time', 'late', 'skipped'] as const).map((status) => (
        <span key={status} className="inline-flex items-center gap-1">
          <i className="inline-block h-[11px] w-[11px] rounded-[3px]" style={SLOT_LOOK[status]} aria-hidden />
          {t(`review.status.${status}`)}
        </span>
      ))}
    </span>
  )
}

/** How many series show before "Show all". */
const PULSE_SHOWN = 8

/**
 * The pulse of repeating tasks: per series its last 16 terms as squares, oldest first, green on time, amber late,
 * grey passed over; in a family with the first letter of who did it. On the right how many were on time.
 */
export function Pulse({ pulse, people, alone }: { pulse: Series[]; people: StatsPerson[]; alone: boolean }) {
  const { t, i18n } = useTranslation()
  const [all, setAll] = useState(false)
  const shown = all ? pulse : pulse.slice(0, PULSE_SHOWN)
  const nameOf = (id: number | null) => people.find((p) => p.id === id)?.name ?? ''
  const percent = (n: number) => (n / 100).toLocaleString(i18n.language, { style: 'percent' })
  return (
    <div className="flex flex-col gap-2.5" data-testid="pulse">
      <div className="grid grid-cols-1 items-center gap-x-3.5 gap-y-1.5 md:grid-cols-[minmax(150px,230px)_minmax(0,1fr)_88px]">
        {shown.map((series) => {
          const rate = pulseRate(series.slots)
          const rhythm = describeRule(series.repeat, series.repeat_from, i18n.language, t)
          const empty = Math.max(0, 16 - series.slots.length)
          return (
            <div key={series.series_id} className="contents" data-series={series.series_id}>
              <div className="flex min-w-0 items-center gap-2 text-[13px] max-md:mt-1.5">
                <ListSquare list={series.list} />
                <span className="truncate text-mist-100" title={series.title}>
                  {series.title}
                </span>
                {rhythm && (
                  <span className="ml-auto max-w-[45%] shrink-0 truncate text-[11.5px] text-mist-600" title={rhythm}>
                    {rhythm}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-[repeat(16,minmax(0,26px))] gap-[4px] sm:gap-[5px]" role="list" aria-label={series.title}>
                {Array.from({ length: empty }, (_, k) => (
                  <i key={`e${k}`} className="aspect-square rounded-[4px] border border-dashed border-ink-700" aria-hidden />
                ))}
                {series.slots.map((slot) => {
                  const who = alone || slot.status === 'skipped' ? '' : nameOf(slot.by)
                  const status = t(`review.status.${slot.status}`)
                  const label = who ? t('review.slotBy', { day: shortDay(slot.due_date, i18n.language), status, name: who }) : t('review.slot', { day: shortDay(slot.due_date, i18n.language), status })
                  return (
                    <i
                      key={slot.due_date}
                      role="listitem"
                      aria-label={label}
                      title={label}
                      className="grid aspect-square place-items-center rounded-[4px] text-[9px] leading-none font-bold text-white not-italic"
                      style={SLOT_LOOK[slot.status]}
                      data-status={slot.status}
                    >
                      {who.trim()[0]?.toUpperCase()}
                    </i>
                  )
                })}
              </div>
              <div className="text-right text-[12px] text-mist-600 tabular-nums max-md:text-left" data-testid="pulse-rate">
                {rate !== null && (
                  <>
                    <b className="text-mist-100">{percent(rate)}</b> {t('review.onTimeWord')}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {pulse.length > PULSE_SHOWN && (
        <button type="button" className="nt-btn nt-btn-quiet self-start text-[13px]" onClick={() => setAll(!all)} data-testid="pulse-more">
          {all ? t('review.pulseLess') : t('review.pulseMore', { count: pulse.length })}
        </button>
      )}
    </div>
  )
}

/** The lists by their share of what was done, as bars in their colours, the share after them. */
export function ListShares({ lists }: { lists: Stats['lists'] }) {
  const { t, i18n } = useTranslation()
  const top = Math.max(...lists.map((entry) => entry.share), 0.01)
  return (
    <div className="flex flex-col gap-2" data-testid="list-shares">
      {lists.slice(0, 8).map((entry) => (
        <div key={entry.list.id} className="grid grid-cols-[minmax(90px,150px)_minmax(0,1fr)_48px] items-center gap-2.5 text-[13px]" data-list={entry.list.id}>
          <span className="flex min-w-0 items-center gap-2">
            <ListSquare list={entry.list} />
            <span className="truncate text-mist-100" title={listName(entry.list, t)}>
              {listName(entry.list, t)}
            </span>
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-ink-800" title={t('review.listCount', { count: entry.count })}>
            <b className="block h-full rounded-full" style={{ width: `${(entry.share / top) * 100}%`, background: entry.list.color ? colorOf(entry.list.color) : 'var(--color-ink-600)' }} />
          </span>
          <span className="text-right text-mist-600 tabular-nums">{entry.share.toLocaleString(i18n.language, { style: 'percent' })}</span>
        </div>
      ))}
    </div>
  )
}

/** Records and milestones: the best day, the best week, the longest run, and the bar to the next milestone. */
export function RecordsBlock({ records }: { records: Records }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const next = records.next_milestone
  const last = records.milestones.length ? records.milestones[records.milestones.length - 1] : null
  const from = last?.count ?? 0
  const part = next ? (records.total - from) / (next.count - from) : 1
  const tiles = [
    { key: 'bestDay', value: records.best_day?.count, line: records.best_day ? shortDay(records.best_day.date, lang) : '' },
    { key: 'bestWeek', value: records.best_week?.count, line: records.best_week ? t('review.weekNo', { week: isoWeek(records.best_week.from), year: records.best_week.from.slice(0, 4) }) : '' },
    { key: 'longest', value: records.longest_streak?.days, line: records.longest_streak ? t('review.span', { from: shortDay(records.longest_streak.from, lang), to: shortDay(records.longest_streak.to, lang) }) : '' },
  ]
  return (
    <div className="flex flex-col gap-4" data-testid="records">
      <div className="grid grid-cols-3 gap-2.5">
        {tiles.map((tile) => (
          <div key={tile.key} className="flex min-w-0 flex-col">
            <small className="text-[11.5px] font-semibold text-mist-600">{t(`review.${tile.key}`)}</small>
            <b className="text-[26px] font-extrabold tracking-[-0.02em] text-mist-100 tabular-nums">{tile.value !== undefined ? fmt(tile.value, lang) : '–'}</b>
            <span className="truncate text-[11.5px] text-mist-600" title={tile.line}>
              {tile.line}
            </span>
          </div>
        ))}
      </div>
      {next && (
        <div className="flex flex-col gap-1.5">
          <div className="relative mb-4 h-2.5 rounded-full bg-ink-800" role="progressbar" aria-valuemin={from} aria-valuemax={next.count} aria-valuenow={records.total} aria-label={t('review.milestoneNext', { missing: fmt(next.missing, lang), count: fmt(next.count, lang) })}>
            <i className="block h-full rounded-full" style={{ width: `${Math.max(2, part * 100)}%`, background: 'linear-gradient(90deg, var(--color-heat-2), var(--color-petrol))' }} />
            <span className="absolute top-[13px] left-0 text-[10.5px] text-mist-600 tabular-nums">{fmt(from, lang)}</span>
            <span className="absolute top-[13px] right-0 text-[10.5px] text-mist-600 tabular-nums">{fmt(next.count, lang)}</span>
          </div>
          <p className="text-[12px] text-mist-600">
            {t('review.milestoneNext', { missing: fmt(next.missing, lang), count: fmt(next.count, lang) })}
            {last && ' ' + t('review.milestoneLast', { count: fmt(last.count, lang), day: shortDay(last.date, lang, true) })}
          </p>
        </div>
      )}
    </div>
  )
}
