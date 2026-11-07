/**
 * Quick entry in plain words (data model, "Schnelleingabe"; decisions 12–24 in `pruefsaetze/LIESMICH.md`):
 * `Milch morgen 9 Uhr #einkauf !!`. Read word by word from the left; at each word in this order: tag, priority,
 * time, date. What is recognised uses up its words; the rest, joined with single spaces, is the title.
 */
import { addDays, weekdayOf } from './repeat'

export interface Quick {
  title: string
  tags: string[]
  priority: number
  due_date: string | null
  due_time: string | null
}

export interface QuickContext {
  /** `de` or `en`: which words count (each only in its language). */
  language: string
  /** Today, `YYYY-MM-DD`, in the browser's time zone. */
  today: string
  /** The time now, `HH:MM`. */
  now: string
}

const WEEKDAYS: Record<'de' | 'en', string[][]> = {
  de: [
    ['montag', 'mo'],
    ['dienstag', 'di'],
    ['mittwoch', 'mi'],
    ['donnerstag', 'do'],
    ['freitag', 'fr'],
    ['samstag', 'sa'],
    ['sonntag', 'so'],
  ],
  en: [
    ['monday', 'mon'],
    ['tuesday', 'tue'],
    ['wednesday', 'wed'],
    ['thursday', 'thu'],
    ['friday', 'fri'],
    ['saturday', 'sat'],
    ['sunday', 'sun'],
  ],
}
const RELATIVE: Record<'de' | 'en', Record<string, number>> = {
  de: { heute: 0, morgen: 1, übermorgen: 2 },
  en: { today: 0, tomorrow: 1 },
}
/** Dropped directly before a recognised date or time. */
const DATE_WORD = { de: 'am', en: 'on' }
const TIME_WORD = { de: 'um', en: 'at' }
const MAX_TAGS = 20

const pad = (n: number) => String(n).padStart(2, '0')

function hm(h: number, m: number): string | null {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null
}

/** A time starting at word `i`: the time, the words it uses, and whether it is a bare number (needs `um`). */
function timeCore(words: string[], i: number, language: 'de' | 'en'): { value: string; used: number; bare: boolean } | null {
  const t = words[i].toLowerCase()
  const ampm = t.match(/^([0-9]{1,2})(?::([0-9]{2}))?(am|pm)$/)
  if (ampm) {
    const h = Number(ampm[1])
    const m = Number(ampm[2] ?? 0)
    if (h < 1 || h > 12 || m > 59) return null
    return { value: hm((h % 12) + (ampm[3] === 'pm' ? 12 : 0), m)!, used: 1, bare: false }
  }
  const colon = t.match(/^([0-9]{1,2}):([0-9]{2})$/)
  let value: string | null
  let bare = false
  if (colon) value = hm(Number(colon[1]), Number(colon[2]))
  else if (language === 'de' && /^[0-9]{1,2}$/.test(t)) {
    value = hm(Number(t), 0)
    bare = true
  } else return null
  if (value === null) return null
  let used = 1
  if (language === 'de' && i + 1 < words.length && words[i + 1].toLowerCase() === 'uhr') {
    used = 2
    bare = false
  }
  return { value, used, bare }
}

function matchTime(words: string[], i: number, language: 'de' | 'en'): { value: string; used: number } | null {
  const lead = words[i].toLowerCase() === TIME_WORD[language] && i + 1 < words.length ? 1 : 0
  const core = timeCore(words, i + lead, language)
  if (!core) return null
  // A bare "9" needs "um" before it or "Uhr" after it.
  if (core.bare && !lead) return null
  return { value: core.value, used: lead + core.used }
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
}

/** Without a year: this year when the day is today or later, else next year; a day the year lacks is nothing. */
function withoutYear(today: string, month: number, day: number): string | null {
  const [y, tm, td] = today.split('-').map(Number)
  const year = month > tm || (month === tm && day >= td) ? y : y + 1
  return validDate(year, month, day)
}

function dateCore(word: string, language: 'de' | 'en', today: string): string | null {
  const t = word.toLowerCase()
  if (t in RELATIVE[language]) return addDays(today, RELATIVE[language][t])
  const index = WEEKDAYS[language].findIndex((names) => names.includes(t))
  if (index >= 0) return addDays(today, (index - weekdayOf(today) + 7) % 7 || 7)
  const dmy = t.match(/^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})$/)
  if (dmy) return validDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
  const dm = t.match(/^([0-9]{1,2})\.([0-9]{1,2})\.$/)
  if (dm) return withoutYear(today, Number(dm[2]), Number(dm[1]))
  if (language === 'en') {
    const md = t.match(/^([0-9]{1,2})\/([0-9]{1,2})$/)
    if (md) return withoutYear(today, Number(md[1]), Number(md[2]))
  }
  return null
}

function matchDate(words: string[], i: number, language: 'de' | 'en', today: string): { value: string; used: number } | null {
  if (words[i].toLowerCase() === DATE_WORD[language] && i + 1 < words.length) {
    const value = dateCore(words[i + 1], language, today)
    if (value) return { value, used: 2 }
  }
  const value = dateCore(words[i], language, today)
  return value ? { value, used: 1 } : null
}

export function parseQuick(text: string, context: QuickContext): Quick {
  const language = context.language === 'de' ? 'de' : 'en'
  const words = text.normalize('NFC').split(/\p{White_Space}+/u).filter(Boolean)
  const keep: string[] = []
  const tags: string[] = []
  const seen = new Set<string>()
  let priority = 0
  let date: string | null = null
  let time: string | null = null

  let i = 0
  while (i < words.length) {
    const word = words[i]
    const body = word.slice(1)
    const length = [...body].length
    if (word.startsWith('#') && length >= 1 && length <= 50 && !body.includes('#')) {
      const key = body.normalize('NFC').toLowerCase()
      if (seen.has(key)) {
        i += 1
        continue
      }
      if (tags.length < MAX_TAGS) {
        seen.add(key)
        tags.push(body)
        i += 1
        continue
      }
    }
    if (!priority && (word === '!' || word === '!!' || word === '!!!')) {
      priority = word.length
      i += 1
      continue
    }
    if (time === null) {
      const hit = matchTime(words, i, language)
      if (hit) {
        time = hit.value
        i += hit.used
        continue
      }
    }
    if (date === null) {
      const hit = matchDate(words, i, language, context.today)
      if (hit) {
        date = hit.value
        i += hit.used
        continue
      }
    }
    keep.push(word)
    i += 1
  }

  // A time without a date: today when it is not before now, else tomorrow.
  if (time !== null && date === null) date = time >= context.now ? context.today : addDays(context.today, 1)
  return { title: keep.join(' '), tags, priority, due_date: date, due_time: time }
}
