/**
 * How due dates and repetitions read on the page: "Today", "Tomorrow 09:30", "Wed", "12 Dec 2027", "Every 2 weeks on
 * Monday and Thursday". Due dates float (no zone): they are read as days in the browser.
 */
import type { TFunction } from 'i18next'

import { addDays, parseRule, WEEKDAYS, type Rule } from '../sync/repeat'
import type { Reminder } from '../sync/types'

export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function localTime(date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function asDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

/** The day in words: today, tomorrow, yesterday, a weekday within the week, else the date. */
export function dayLabel(day: string, today: string, language: string, t: TFunction): string {
  if (day === today) return t('due.today')
  if (day === addDays(today, 1)) return t('due.tomorrow')
  if (day === addDays(today, -1)) return t('due.yesterday')
  const date = asDate(day)
  if (day > today && day <= addDays(today, 6)) return date.toLocaleDateString(language, { weekday: 'long' })
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  return date.toLocaleDateString(language, sameYear ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

export function dueLabel(reminder: Pick<Reminder, 'due_date' | 'due_time'>, today: string, language: string, t: TFunction): string {
  if (!reminder.due_date) return ''
  const day = dayLabel(reminder.due_date, today, language, t)
  return reminder.due_time ? `${day}, ${reminder.due_time}` : day
}

/** Past its day, or today past its time. */
export function overdue(reminder: Pick<Reminder, 'due_date' | 'due_time' | 'completed_at'>, today: string, now: string): boolean {
  if (!reminder.due_date || reminder.completed_at) return false
  if (reminder.due_date < today) return true
  return reminder.due_date === today && !!reminder.due_time && reminder.due_time < now
}

/** A long date for headings ("Friday, 6 November"). */
export function longDay(day: string, language: string): string {
  return asDate(day).toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long' })
}

function weekdayName(day: string, language: string): string {
  // 2026-11-02 was a Monday.
  return asDate(addDays('2026-11-02', WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number]))).toLocaleDateString(language, { weekday: 'long' })
}

function monthName(month: number, language: string): string {
  return new Date(2026, month - 1, 1).toLocaleDateString(language, { month: 'long' })
}

/** A rule in a sentence; null when there is none or it cannot be read. */
export function describeRule(text: string | null, from: 'due' | 'completion', language: string, t: TFunction): string | null {
  const rule: Rule | null = parseRule(text, from)
  if (!rule) return null
  const n = rule.interval
  let sentence: string
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[rule.freq]
  if (from === 'completion') sentence = t(`repeat.afterDone.${unit}`, { count: n })
  else {
    sentence = t(`repeat.every.${unit}`, { count: n })
    if (rule.freq === 'WEEKLY' && rule.byday) sentence += ' ' + t('repeat.onDays', { days: listOf(rule.byday.map((d) => weekdayName(d.day, language)), language) })
    if (rule.freq === 'MONTHLY' && rule.bymonthday !== undefined)
      sentence += ' ' + (rule.bymonthday === -1 ? t('repeat.onLastDay') : t('repeat.onDay', { day: rule.bymonthday }))
    if (rule.freq === 'MONTHLY' && rule.byday?.[0]) {
      const { ord, day } = rule.byday[0]
      sentence += ' ' + t('repeat.onNth', { nth: t(`repeat.nth.${ord === -1 ? 'last' : ord}`), day: weekdayName(day, language) })
    }
    if (rule.freq === 'YEARLY' && rule.bymonth !== undefined)
      sentence += ' ' + (rule.bymonthday === -1 ? t('repeat.onLastOfMonth', { month: monthName(rule.bymonth, language) }) : t('repeat.onDate', { day: rule.bymonthday, month: monthName(rule.bymonth, language) }))
  }
  if (rule.count !== undefined) sentence += ', ' + t('repeat.times', { count: rule.count })
  if (rule.until) sentence += ', ' + t('repeat.until', { day: asDate(rule.until).toLocaleDateString(language, { day: 'numeric', month: 'long', year: 'numeric' }) })
  return sentence
}

function listOf(items: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(items)
  } catch {
    return items.join(', ')
  }
}
