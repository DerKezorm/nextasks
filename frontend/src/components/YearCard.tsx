/**
 * "Your year" as one card (concept "Allein nutzen", "Dein Jahr"): drawn as plain SVG at 1080 × 1400, so what the page
 * shows is what "Save as picture" keeps (`lib/picture.ts`). The year's number big, the change to the year before, the
 * strongest month, the favourite time, the longest streak, the most used list, the months as bars, the days as a small
 * heat map; in a family everyone with what they did, alone the best day, all time and how many were made. Colours
 * from the theme, so it fits light and dark.
 */
import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'

import { colorOf } from '../lib/look'
import { count as fmt, gridOf, heat, heatSteps, hourName, monthName, shiftDay, shortDay, weekdayName, type Stats } from '../lib/stats'
import { personColor } from './Avatar'

export const CARD_WIDTH = 1080
export const CARD_HEIGHT = 1400
const P = 72
const INNER = CARD_WIDTH - 2 * P
const FONT = "'Inter Variable', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"

/** A text cut to about `room` pixels at type size `size`. */
function fit(text: string, room: number, size: number): string {
  const letters = Math.floor(room / (size * 0.55))
  return text.length > letters ? text.slice(0, Math.max(1, letters - 1)) + '…' : text
}

export const YearCard = forwardRef<SVGSVGElement, { stats: Stats }>(function YearCard({ stats }, ref) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const block = stats.year!
  const year = block.year
  const alone = stats.scope.alone
  const previous = stats.total.previous
  const difference = block.completed - previous
  const compare = !previous
    ? t('review.year.first', { year: year - 1 })
    : difference > 0
      ? t('review.year.more', { number: fmt(difference, lang), year: year - 1 })
      : difference < 0
        ? t('review.year.fewer', { number: fmt(-difference, lang), year: year - 1 })
        : t('review.year.same', { year: year - 1 })
  const facts = [
    { label: t('review.year.bestMonth'), value: block.best_month ? monthName(block.best_month, lang) : '–' },
    {
      label: t('review.year.favourite'),
      value: block.best_weekday !== null && block.best_hour !== null ? t('review.year.favouriteValue', { weekday: weekdayName(block.best_weekday, lang, 'long'), hour: hourName(block.best_hour, lang) }) : '–',
    },
    { label: t('review.year.longest'), value: block.longest_streak ? t('review.streakDays', { count: block.longest_streak.days }) : '–' },
    { label: t('review.year.topList'), value: block.top_list ? (block.top_list.list.name ?? t('review.deletedList')) : '–', color: block.top_list?.list.color },
  ]

  // The months as bars, the strongest in petrol.
  const monthTop = 760
  const barArea = 150
  const barGap = 14
  const barW = (INNER - 11 * barGap) / 12
  const monthMax = Math.max(1, ...block.months)

  // The days of the year as a small heat map, Monday on top.
  const first = `${year}-01-01`
  const { lead, columns } = gridOf(first, block.days.length)
  const heatTop = 1040
  const step = INNER / columns
  const cell = step - 3
  const steps = heatSteps(block.days)

  const people = stats.by_person.slice(0, 6)
  const nameOf = (id: number | null) => stats.people.find((p) => p.id === id)?.name ?? ''
  const best = stats.records.best_day

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
      className="block h-auto w-full"
      role="img"
      aria-label={t('review.year.label', { year })}
      fontFamily={FONT}
      data-testid="year-card"
    >
      <defs>
        <linearGradient id="year-glow" x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="var(--color-petrol)" stopOpacity={0.26} />
          <stop offset="0.7" stopColor="var(--color-petrol)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <rect x={1} y={1} width={CARD_WIDTH - 2} height={CARD_HEIGHT - 2} rx={44} fill="var(--color-ink-850)" stroke="var(--color-ink-700)" strokeWidth={2} />
      <rect x={1} y={1} width={CARD_WIDTH - 2} height={CARD_HEIGHT - 2} rx={44} fill="url(#year-glow)" />

      <text x={P} y={118} fontSize={30} fontWeight={800} letterSpacing={3} fill="var(--color-accent-400)">
        {t('review.year.title', { year }).toUpperCase()}
      </text>
      <text x={CARD_WIDTH - P} y={118} fontSize={28} fontWeight={700} textAnchor="end" fill="var(--color-mist-100)">
        NEX<tspan fill="var(--color-accent-500)">TASKS</tspan>
      </text>

      <text x={P - 6} y={318} fontSize={200} fontWeight={800} letterSpacing={-6} fill="var(--color-mist-100)" data-testid="year-count">
        {fmt(block.completed, lang)}
      </text>
      <text x={P} y={380} fontSize={36} fill="var(--color-mist-300)">
        {fit(t(alone ? 'review.year.doneAlone' : 'review.year.doneFamily', { year }), INNER, 36)}
      </text>
      <text x={P} y={430} fontSize={30} fontWeight={600} fill={difference > 0 && previous ? 'var(--color-ok-500)' : 'var(--color-mist-500)'}>
        {compare}
      </text>

      {facts.map((fact, i) => {
        const x = P + (i % 2) * (INNER / 2 + 12)
        const y = 520 + Math.floor(i / 2) * 118
        return (
          <g key={fact.label}>
            <text x={x} y={y} fontSize={24} fontWeight={600} fill="var(--color-mist-500)">
              {fact.label}
            </text>
            {fact.color && <rect x={x} y={y + 22} width={26} height={26} rx={7} fill={colorOf(fact.color)} />}
            <text x={x + (fact.color ? 40 : 0)} y={y + 47} fontSize={42} fontWeight={800} fill="var(--color-mist-100)">
              {fit(fact.value, INNER / 2 - 20 - (fact.color ? 40 : 0), 42)}
            </text>
          </g>
        )
      })}

      <text x={P} y={monthTop} fontSize={24} fontWeight={600} fill="var(--color-mist-500)">
        {t('review.year.months')}
      </text>
      {block.months.map((n, i) => {
        const h = Math.max(n ? 6 : 2, (n / monthMax) * barArea)
        const x = P + i * (barW + barGap)
        const bottom = monthTop + 30 + barArea
        const strongest = block.best_month === i + 1
        return (
          <g key={i} data-month={i + 1} data-count={n}>
            <rect x={x} y={bottom - h} width={barW} height={h} rx={8} fill={strongest ? 'var(--color-petrol)' : 'var(--color-heat-2)'} />
            {strongest && (
              <text x={x + barW / 2} y={bottom - h - 12} fontSize={22} fontWeight={700} textAnchor="middle" fill="var(--color-mist-100)">
                {fmt(n, lang)}
              </text>
            )}
            <text x={x + barW / 2} y={bottom + 34} fontSize={22} textAnchor="middle" fill={strongest ? 'var(--color-mist-100)' : 'var(--color-mist-600)'} fontWeight={strongest ? 700 : 400}>
              {monthName(i + 1, lang, 'narrow')}
            </text>
          </g>
        )
      })}

      <text x={P} y={heatTop} fontSize={24} fontWeight={600} fill="var(--color-mist-500)">
        {t('review.year.days')}
      </text>
      {block.days.map((n, i) => (
        <rect key={i} x={P + Math.floor((lead + i) / 7) * step} y={heatTop + 24 + ((lead + i) % 7) * step} width={cell} height={cell} rx={3} fill={heat(steps[i])}>
          <title>{t('review.heatDay', { count: n, day: shortDay(shiftDay(first, i), lang, true) })}</title>
        </rect>
      ))}

      {alone ? (
        <g>
          {[
            { label: t('review.year.bestDay'), value: best ? fmt(best.count, lang) : '–', line: best ? shortDay(best.date, lang, true) : '' },
            { label: t('review.year.allTime'), value: fmt(stats.records.total, lang), line: '' },
            { label: t('review.year.created'), value: fmt(block.created, lang), line: '' },
          ].map((item, i) => {
            const x = P + i * (INNER / 3)
            return (
              <g key={item.label}>
                <text x={x} y={1240} fontSize={22} fontWeight={600} fill="var(--color-mist-500)">
                  {item.label}
                </text>
                <text x={x} y={1286} fontSize={40} fontWeight={800} fill="var(--color-mist-100)">
                  {item.value}
                </text>
                {item.line && (
                  <text x={x} y={1318} fontSize={20} fill="var(--color-mist-600)">
                    {fit(item.line, INNER / 3 - 16, 20)}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      ) : (
        <g>
          <text x={P} y={1236} fontSize={24} fontWeight={600} fill="var(--color-mist-500)">
            {t('review.year.people')}
          </text>
          {people.map((person, i) => {
            const name = nameOf(person.id)
            const color = personColor(name)
            const x = P + i * (INNER / Math.max(people.length, 4))
            return (
              <g key={person.id ?? 'former'} data-person={person.id ?? 'former'}>
                <circle cx={x + 26} cy={1282} r={26} fill={color} fillOpacity={0.3} />
                <text x={x + 26} y={1291} fontSize={24} fontWeight={700} textAnchor="middle" fill={color}>
                  {(name.trim()[0] ?? '?').toUpperCase()}
                </text>
                <text x={x + 62} y={1276} fontSize={22} fill="var(--color-mist-300)">
                  {fit(name, INNER / Math.max(people.length, 4) - 70, 22)}
                </text>
                <text x={x + 62} y={1304} fontSize={24} fontWeight={800} fill="var(--color-mist-100)">
                  {fmt(person.count, lang)}
                </text>
              </g>
            )
          })}
        </g>
      )}

      <text x={P} y={CARD_HEIGHT - 44} fontSize={20} fill="var(--color-mist-600)">
        {t('review.year.foot', { year })}
      </text>
    </svg>
  )
})
