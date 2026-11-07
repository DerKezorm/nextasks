/**
 * Repetition (data model, "Wiederholung"): the RRULE subset nextasks writes, reading and writing it, and the next due
 * date. Dates are `YYYY-MM-DD` without a time zone; all arithmetic runs on UTC days so no zone can move them.
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

export interface Rule {
  freq: Freq
  interval: number
  /** YEARLY: the month, 1–12. */
  bymonth?: number
  /** MONTHLY or YEARLY: 1–31 or -1 (the last day). */
  bymonthday?: number
  /** WEEKLY: days without number; MONTHLY: one day with its ordinal (1–4 or -1). */
  byday?: { ord: number | null; day: Weekday }[]
  count?: number
  /** `YYYY-MM-DD`, inclusive. */
  until?: string
}

const ORDER = ['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'COUNT', 'UNTIL']

/** Reads a rule; null when it is not in the subset (or not in its exact spelling). */
export function parseRule(text: string | null | undefined, from: 'due' | 'completion' = 'due'): Rule | null {
  if (!text || (from !== 'due' && from !== 'completion')) return null
  const parts = text.split(';')
  const seen: string[] = []
  const values: Record<string, string> = {}
  for (const part of parts) {
    const [name, value, ...rest] = part.split('=')
    if (!name || value === undefined || rest.length || !/^[A-Z]+$/.test(name) || name in values) return null
    values[name] = value
    seen.push(name)
  }
  // The parts in their fixed order, nothing else.
  let last = -1
  for (const name of seen) {
    const index = ORDER.indexOf(name)
    if (index < 0 || index <= last) return null
    last = index
  }
  if ('COUNT' in values && 'UNTIL' in values) return null
  const freq = values.FREQ as Freq
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null
  const rule: Rule = { freq, interval: 1 }
  if ('INTERVAL' in values) {
    if (!/^[1-9][0-9]?$/.test(values.INTERVAL)) return null
    rule.interval = Number(values.INTERVAL)
    if (rule.interval < 2) return null
  }
  if ('COUNT' in values) {
    if (!/^[1-9][0-9]{0,2}$/.test(values.COUNT)) return null
    rule.count = Number(values.COUNT)
  }
  if ('UNTIL' in values) {
    const m = values.UNTIL.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (!m) return null
    const until = `${m[1]}-${m[2]}-${m[3]}`
    if (!validDate(until)) return null
    rule.until = until
  }
  if ('BYMONTH' in values) {
    if (!/^(?:[1-9]|1[0-2])$/.test(values.BYMONTH)) return null
    rule.bymonth = Number(values.BYMONTH)
  }
  if ('BYMONTHDAY' in values) {
    if (!/^(?:-1|[1-9]|[12][0-9]|3[01])$/.test(values.BYMONTHDAY)) return null
    rule.bymonthday = Number(values.BYMONTHDAY)
  }
  if ('BYDAY' in values) {
    const days: { ord: number | null; day: Weekday }[] = []
    for (const item of values.BYDAY.split(',')) {
      const m = item.match(/^(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/)
      if (!m) return null
      days.push({ ord: m[1] ? Number(m[1]) : null, day: m[2] as Weekday })
    }
    rule.byday = days
  }
  const has = (name: string) => name in values
  if (from === 'completion' && (has('BYMONTH') || has('BYMONTHDAY') || has('BYDAY'))) return null
  switch (freq) {
    case 'DAILY':
      if (has('BYMONTH') || has('BYMONTHDAY') || has('BYDAY')) return null
      break
    case 'WEEKLY': {
      if (has('BYMONTH') || has('BYMONTHDAY')) return null
      if (from === 'completion') break
      if (!rule.byday?.length || rule.byday.length > 7 || rule.byday.some((d) => d.ord !== null)) return null
      // MO…SU in order, each once.
      const indices = rule.byday.map((d) => WEEKDAYS.indexOf(d.day))
      if (indices.some((v, i) => i > 0 && v <= indices[i - 1])) return null
      break
    }
    case 'MONTHLY':
      if (has('BYMONTH')) return null
      if (from === 'completion') break
      if (has('BYMONTHDAY') === has('BYDAY')) return null
      if (rule.byday && (rule.byday.length !== 1 || rule.byday[0].ord === null)) return null
      break
    case 'YEARLY':
      if (has('BYDAY')) return null
      if (from === 'completion') break
      if (!has('BYMONTH') || !has('BYMONTHDAY')) return null
      break
  }
  return rule
}

/** Writes a rule in the fixed spelling. */
export function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.bymonth !== undefined) parts.push(`BYMONTH=${rule.bymonth}`)
  if (rule.bymonthday !== undefined) parts.push(`BYMONTHDAY=${rule.bymonthday}`)
  if (rule.byday?.length) {
    const days = [...rule.byday].sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day))
    parts.push('BYDAY=' + days.map((d) => `${d.ord ?? ''}${d.day}`).join(','))
  }
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  else if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`)
  return parts.join(';')
}

// ---- Days -----------------------------------------------------------------------------------------------------------

function validDate(value: string): boolean {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo)
}

export function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

type Ymd = { y: number; m: number; d: number }

function split(value: string): Ymd {
  const [y, m, d] = value.split('-').map(Number)
  return { y, m, d }
}

function join({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function toDays(value: string): number {
  const { y, m, d } = split(value)
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

function fromDays(days: number): string {
  const date = new Date(days * 86_400_000)
  return join({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() })
}

export function addDays(value: string, n: number): string {
  return fromDays(toDays(value) + n)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(value: string): number {
  return (toDays(value) + 3) % 7 // 1970-01-01 was a Thursday
}

/** Day `day` of a month, or its last day when the month is shorter (the data model's deliberate deviation). */
function capped(y: number, m: number, day: number): string {
  const last = daysIn(y, m)
  return join({ y, m, d: day === -1 ? last : Math.min(day, last) })
}

function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const total = y * 12 + (m - 1) + n
  return { y: Math.floor(total / 12), m: (total % 12) + 1 }
}

/** The `ord`-th weekday of a month (1–4, or -1 for the last); null if there is none. */
function nthWeekday(y: number, m: number, ord: number, day: Weekday): string {
  const want = WEEKDAYS.indexOf(day)
  if (ord === -1) {
    const last = join({ y, m, d: daysIn(y, m) })
    const back = (weekdayOf(last) - want + 7) % 7
    return addDays(last, -back)
  }
  const first = join({ y, m, d: 1 })
  const ahead = (want - weekdayOf(first) + 7) % 7
  return addDays(first, ahead + (ord - 1) * 7)
}

/**
 * The next due date after `base` (exactly one step; may still lie in the past), or null when the rule ends there
 * (`COUNT` is not looked at here). `repeat_from: completion` counts from `on`, the day of completing.
 */
export function nextDate(rule: Rule, base: string, from: 'due' | 'completion' = 'due', on?: string): string | null {
  const n = rule.interval
  let next: string
  if (from === 'completion') {
    const start = on ?? base
    const { y, m, d } = split(start)
    switch (rule.freq) {
      case 'DAILY':
        next = addDays(start, n)
        break
      case 'WEEKLY':
        next = addDays(start, 7 * n)
        break
      case 'MONTHLY': {
        const to = addMonths(y, m, n)
        next = capped(to.y, to.m, d)
        break
      }
      case 'YEARLY':
        next = capped(y + n, m, d)
        break
    }
  } else {
    const { y, m } = split(base)
    switch (rule.freq) {
      case 'DAILY':
        next = addDays(base, n)
        break
      case 'WEEKLY': {
        const days = (rule.byday ?? []).map((d) => WEEKDAYS.indexOf(d.day))
        const monday = toDays(base) - weekdayOf(base)
        let found: string | null = null
        for (let step = 1; step <= 7 * n + 7 && !found; step++) {
          const candidate = addDays(base, step)
          const week = Math.floor((toDays(candidate) - monday) / 7)
          if (week % n === 0 && days.includes(weekdayOf(candidate))) found = candidate
        }
        if (!found) return null
        next = found
        break
      }
      case 'MONTHLY': {
        let found: string | null = null
        for (let k = 0; k <= n * 2 + 1 && !found; k += n) {
          const at = addMonths(y, m, k)
          const candidate =
            rule.bymonthday !== undefined ? capped(at.y, at.m, rule.bymonthday) : nthWeekday(at.y, at.m, rule.byday![0].ord!, rule.byday![0].day)
          if (candidate > base) found = candidate
        }
        if (!found) return null
        next = found
        break
      }
      case 'YEARLY': {
        let found: string | null = null
        for (let k = 0; k <= n * 2 + 1 && !found; k += n) {
          const candidate = capped(y + k, rule.bymonth!, rule.bymonthday!)
          if (candidate > base) found = candidate
        }
        if (!found) return null
        next = found
        break
      }
    }
  }
  if (rule.until && next > rule.until) return null
  return next
}

/**
 * What completing a repeated reminder does to its rule: `ended` when nothing follows (COUNT=1 or past UNTIL),
 * otherwise the next due date and the rule to write (COUNT one less).
 */
export function step(repeat: string, repeatFrom: 'due' | 'completion', due: string, on: string): { ended: true } | { ended: false; due: string; repeat: string } {
  const rule = parseRule(repeat, repeatFrom)
  if (!rule) return { ended: true }
  if (rule.count === 1) return { ended: true }
  const next = nextDate(rule, due, repeatFrom, on)
  if (!next) return { ended: true }
  const after = rule.count !== undefined ? formatRule({ ...rule, count: rule.count - 1 }) : repeat
  return { ended: false, due: next, repeat: after }
}

/** The next due date with `COUNT` and `UNTIL` looked at: null when the rule ends here. */
export function nextDue(repeat: string, from: 'due' | 'completion', due: string, on: string): string | null {
  const rule = parseRule(repeat, from)
  if (!rule || rule.count === 1) return null
  return nextDate(rule, due, from, on)
}
