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

/** A point in time as `moment` writes it, in the account's own time zone (E14; the server says it in `Me.timezone`),
 * not the browser's: the settings' backups and log read the same as the account's due times. A zone the browser
 * does not know: the browser's. */
export function momentIn(value: string | number | Date, lang: string, zone: string | undefined): string {
  const format: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  try {
    return new Date(value).toLocaleString(lang, zone ? { ...format, timeZone: zone } : format)
  } catch {
    return new Date(value).toLocaleString(lang, format)
  }
}

/** The time of day ("14:05") in the account's time zone. */
export function clockIn(value: string | number | Date, lang: string, zone: string | undefined): string {
  const format: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  try {
    return new Date(value).toLocaleTimeString(lang, zone ? { ...format, timeZone: zone } : format)
  } catch {
    return new Date(value).toLocaleTimeString(lang, format)
  }
}
