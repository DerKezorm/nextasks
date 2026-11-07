/**
 * Repetition as a dialog in words, not RRULE text: how often, on which days, counted from the due date or from
 * completing, and when it ends. It writes exactly the subset of the data model ("Wiederholung").
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { describeRule } from '../lib/due'
import { formatRule, parseRule, WEEKDAYS, weekdayOf, type Freq, type Rule, type Weekday } from '../sync/repeat'
import { Dialog } from './Dialog'

export interface RepeatValue {
  repeat: string | null
  repeat_from: 'due' | 'completion'
}

const FREQS: Freq[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

function dayName(day: Weekday, language: string, style: 'short' | 'long'): string {
  return new Date(2026, 10, 2 + WEEKDAYS.indexOf(day)).toLocaleDateString(language, { weekday: style })
}

export function RepeatDialog({ value, due, onSave, onClose }: { value: RepeatValue; due: string; onSave: (value: RepeatValue) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const start = parseRule(value.repeat, value.repeat_from)
  const [y, m, d] = due.split('-').map(Number)
  const dueDay = WEEKDAYS[weekdayOf(due)]
  const [on, setOn] = useState(value.repeat !== null)
  const [freq, setFreq] = useState<Freq>(start?.freq ?? 'WEEKLY')
  const [interval, setInterval] = useState(start?.interval ?? 1)
  const [from, setFrom] = useState<'due' | 'completion'>(value.repeat_from)
  const [days, setDays] = useState<Weekday[]>(start?.freq === 'WEEKLY' && start.byday ? start.byday.map((b) => b.day) : [dueDay])
  const [monthly, setMonthly] = useState<'day' | 'nth'>(start?.freq === 'MONTHLY' && start.byday ? 'nth' : 'day')
  const [monthDay, setMonthDay] = useState(start?.bymonthday ?? d)
  const [nth, setNth] = useState(start?.byday?.[0]?.ord ?? Math.min(4, Math.ceil(d / 7)))
  const [nthDay, setNthDay] = useState<Weekday>(start?.byday?.[0]?.day ?? dueDay)
  const [month, setMonth] = useState(start?.bymonth ?? m)
  const [end, setEnd] = useState<'never' | 'count' | 'until'>(start?.count !== undefined ? 'count' : start?.until ? 'until' : 'never')
  const [count, setCount] = useState(start?.count ?? 10)
  const [until, setUntil] = useState(start?.until ?? `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)

  const rule: Rule | null = useMemo(() => {
    if (!on) return null
    const r: Rule = { freq, interval: Math.max(1, Math.min(99, interval || 1)) }
    if (from === 'due') {
      if (freq === 'WEEKLY') r.byday = (days.length ? days : [dueDay]).map((day) => ({ ord: null, day }))
      if (freq === 'MONTHLY') {
        if (monthly === 'day') r.bymonthday = monthDay
        else r.byday = [{ ord: nth, day: nthDay }]
      }
      if (freq === 'YEARLY') {
        r.bymonth = month
        r.bymonthday = monthDay
      }
    }
    if (end === 'count') r.count = Math.max(1, Math.min(999, count || 1))
    if (end === 'until') r.until = until
    return r
  }, [on, freq, interval, from, days, dueDay, monthly, monthDay, nth, nthDay, month, end, count, until])

  const text = rule ? formatRule(rule) : null
  const valid = text === null || parseRule(text, from) !== null
  const sentence = text ? describeRule(text, from, i18n.language, t) : t('repeat.never')
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[freq]
  const field = 'rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-mist-100'
  const label = 'text-xs font-medium text-mist-500'

  return (
    <Dialog title={t('repeat.title')} onClose={onClose} medium>
      <div className="space-y-4 text-sm">
        <label className="flex items-center gap-3">
          <span className={label + ' w-24'}>{t('repeat.repeat')}</span>
          <select className={field} value={on ? freq : 'none'} onChange={(e) => (e.target.value === 'none' ? setOn(false) : (setOn(true), setFreq(e.target.value as Freq)))} aria-label={t('repeat.repeat')}>
            <option value="none">{t('repeat.never')}</option>
            {FREQS.map((f) => (
              <option key={f} value={f}>
                {t(`repeat.freq.${f}`)}
              </option>
            ))}
          </select>
        </label>
        {on && (
          <>
            <label className="flex flex-wrap items-center gap-3">
              <span className={label + ' w-24'}>{t('repeat.everyLabel')}</span>
              <input type="number" min={1} max={99} value={interval} onChange={(e) => setInterval(Number(e.target.value))} className={field + ' w-20'} aria-label={t('repeat.everyLabel')} />
              <span className="text-mist-300">{t(`repeat.unit.${unit}`, { count: interval })}</span>
            </label>
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className={label + ' float-left w-24'}>{t('repeat.from')}</legend>
              <label className="flex items-center gap-1.5 text-mist-200">
                <input type="radio" checked={from === 'due'} onChange={() => setFrom('due')} className="accent-accent-500" /> {t('repeat.fromDue')}
              </label>
              <label className="flex items-center gap-1.5 text-mist-200">
                <input type="radio" checked={from === 'completion'} onChange={() => setFrom('completion')} className="accent-accent-500" /> {t('repeat.fromCompletion')}
              </label>
            </fieldset>
            {from === 'due' && freq === 'WEEKLY' && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('repeat.days')}>
                {WEEKDAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={days.includes(day)}
                    aria-label={dayName(day, i18n.language, 'long')}
                    onClick={() => setDays((list) => (list.includes(day) ? list.filter((x) => x !== day) : [...list, day]))}
                    className={'h-9 w-11 rounded-full border text-xs font-semibold ' + (days.includes(day) ? 'border-accent-500 bg-accent-500 text-on-accent' : 'border-ink-700 text-mist-300 hover:bg-ink-800')}
                  >
                    {dayName(day, i18n.language, 'short')}
                  </button>
                ))}
              </div>
            )}
            {from === 'due' && freq === 'MONTHLY' && (
              <div className="space-y-2">
                <label className="flex flex-wrap items-center gap-2 text-mist-200">
                  <input type="radio" checked={monthly === 'day'} onChange={() => setMonthly('day')} className="accent-accent-500" /> {t('repeat.onTheDay')}
                  <DaySelect value={monthDay} onChange={setMonthDay} className={field} />
                </label>
                <label className="flex flex-wrap items-center gap-2 text-mist-200">
                  <input type="radio" checked={monthly === 'nth'} onChange={() => setMonthly('nth')} className="accent-accent-500" /> {t('repeat.onThe')}
                  <select className={field} value={nth} onChange={(e) => setNth(Number(e.target.value))} aria-label={t('repeat.which')}>
                    {[1, 2, 3, 4, -1].map((n) => (
                      <option key={n} value={n}>
                        {t(`repeat.nth.${n === -1 ? 'last' : n}`)}
                      </option>
                    ))}
                  </select>
                  <select className={field} value={nthDay} onChange={(e) => setNthDay(e.target.value as Weekday)} aria-label={t('repeat.weekday')}>
                    {WEEKDAYS.map((day) => (
                      <option key={day} value={day}>
                        {dayName(day, i18n.language, 'long')}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {from === 'due' && freq === 'YEARLY' && (
              <label className="flex flex-wrap items-center gap-2 text-mist-200">
                {t('repeat.onTheDay')}
                <DaySelect value={monthDay} onChange={setMonthDay} className={field} />
                <select className={field} value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label={t('repeat.month')}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {new Date(2026, i, 1).toLocaleDateString(i18n.language, { month: 'long' })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="space-y-2">
              <legend className={label}>{t('repeat.end')}</legend>
              <label className="flex items-center gap-2 text-mist-200">
                <input type="radio" checked={end === 'never'} onChange={() => setEnd('never')} className="accent-accent-500" /> {t('repeat.endNever')}
              </label>
              <label className="flex flex-wrap items-center gap-2 text-mist-200">
                <input type="radio" checked={end === 'count'} onChange={() => setEnd('count')} className="accent-accent-500" /> {t('repeat.endAfter')}
                <input type="number" min={1} max={999} value={count} onChange={(e) => (setCount(Number(e.target.value)), setEnd('count'))} className={field + ' w-20'} aria-label={t('repeat.endAfter')} />
                {t('repeat.endTimes', { count })}
              </label>
              <label className="flex flex-wrap items-center gap-2 text-mist-200">
                <input type="radio" checked={end === 'until'} onChange={() => setEnd('until')} className="accent-accent-500" /> {t('repeat.endOn')}
                <input type="date" value={until} min={due} onChange={(e) => (setUntil(e.target.value), setEnd('until'))} className={field} aria-label={t('repeat.endOn')} />
              </label>
            </fieldset>
          </>
        )}
        <p className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-mist-200" data-testid="repeat-sentence" aria-live="polite">
          {sentence}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="nc-btn nc-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="nc-btn nc-btn-accent"
            disabled={!valid}
            onClick={() => {
              onSave({ repeat: text, repeat_from: text ? from : 'due' })
              onClose()
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function DaySelect({ value, onChange, className }: { value: number; onChange: (v: number) => void; className: string }) {
  const { t } = useTranslation()
  return (
    <select className={className} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={t('repeat.dayOfMonth')}>
      {Array.from({ length: 31 }, (_, i) => (
        <option key={i + 1} value={i + 1}>
          {i + 1}.
        </option>
      ))}
      <option value={-1}>{t('repeat.lastDay')}</option>
    </select>
  )
}
