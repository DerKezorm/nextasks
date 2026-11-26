import { formatDay, formatMoment, formatTime } from '../vendor/nexui'

/** "5 minutes ago", "yesterday" in the language of the app. */
export function ago(time: number, lang: string): string {
  const seconds = Math.round((time - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(0, 'minute')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86400 * 30) return format.format(Math.round(seconds / 86400), 'day')
  return new Date(time).toLocaleDateString(lang)
}

/** A point in time, one way across the app and as in nexbrand: "4.10.2026, 22:35", no seconds (Prüfgang G11). */
export function moment(value: string | number | Date, lang: string): string {
  return new Date(value).toLocaleString(lang, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The wall clock of `value` in `zone` as a Date of the browser whose own fields read that clock (so the helpers of ui,
 * which read the browser's fields, write the account's time). A zone the browser does not know: the browser's. */
function wallClock(value: string | number | Date, zone: string | undefined): Date | null {
  const found = new Date(value)
  if (Number.isNaN(found.getTime())) return null
  if (!zone) return found
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(found)
        .map((part) => [part.type, Number(part.value)]),
    )
    return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  } catch {
    return found
  }
}

/** A moment in the settings, in the one form of all apps (E65, ui 1.1.2 `formatMoment`): "heute, 14:05", "gestern,
 * 14:05", else "24.02.2027, 14:05", in the account's own time zone (E14; the server says it in `Me.timezone`), not the
 * browser's: keys, connections, backups and the log read the same as the account's due times. */
export function momentIn(value: string | number | Date, lang: string, zone: string | undefined, now: Date = new Date()): string {
  const found = wallClock(value, zone)
  if (!found) return String(value)
  return formatMoment(found, lang, wallClock(now, zone) ?? now)
}

/** The time of day ("14:05", 24 hours, ui `formatTime`) in the account's time zone. */
export function clockIn(value: string | number | Date, lang: string, zone: string | undefined): string {
  const found = wallClock(value, zone)
  return found ? formatTime(found, lang) : String(value)
}

/** A day in the settings ("24.02.2027", ui `formatDay`): an expiry, the day a password changed. */
export function dayOf(value: string | number | Date, lang: string): string {
  const found = new Date(value)
  return Number.isNaN(found.getTime()) ? String(value) : formatDay(found, lang)
}
