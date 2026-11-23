/**
 * Parts of the own account that belong to the new nextasks: the time zone (due times are meant in it). The iPhone app
 * (pairing by QR code or code, the devices signed in) moved to `devices/`, as in nexnotes; notifications in this
 * browser (web push) to "Notifications" (`components/Notifications.tsx`), as the channel "Browser".
 */
import { Clock3 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../api/client'
import { errorText } from '../lib/errors'
import { useEngine, useSyncState } from '../state/sync'
import { AppError } from '../sync/transport'
import { Section } from './Section'

function codeOf(error: unknown): string {
  return error instanceof ApiError || error instanceof AppError ? error.code : 'internal_error'
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

export function TimeZone() {
  const { t } = useTranslation()
  const engine = useEngine()
  useSyncState()
  const current = engine.me?.account.timezone ?? ''
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const list = zones()
  const options = list.includes(current) || !current ? list : [current, ...list]
  const save = (timezone: string) => {
    setSaved(false)
    setProblem(null)
    engine.setMe({ timezone }).then(
      () => setSaved(true),
      (error) => setProblem(errorText(codeOf(error))),
    )
  }
  return (
    <Section icon={Clock3} title={t('zone.title')}>
      <p className="mb-3 text-sm text-mist-400">{t('zone.text')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('zone.title')} className="nt-field w-auto max-w-full px-2" value={current} onChange={(e) => save(e.target.value)} data-testid="timezone">
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        {browser && browser !== current && (
          <button type="button" className="nt-btn nt-btn-ghost" onClick={() => save(browser)}>
            {t('zone.useBrowser', { zone: browser })}
          </button>
        )}
      </div>
      {saved && <p className="mt-2 text-xs text-ok-500">{t('zone.saved')}</p>}
      {problem && <p className="mt-2 text-xs text-bad-500">{problem}</p>}
    </Section>
  )
}
