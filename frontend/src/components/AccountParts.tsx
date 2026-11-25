/**
 * Parts of the own account that belong to the new nextasks: the time zone (due times are meant in it). The iPhone app
 * (pairing by QR code or code, the devices signed in) moved to `devices/`, as in nexnotes; notifications in this
 * browser (web push) to "Notifications" (`components/Notifications.tsx`), as the channel "Browser".
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../api/client'
import { errorText } from '../lib/errors'
import { useEngine, useSyncState } from '../state/sync'
import { AppError } from '../sync/transport'
import { Button, Buttons, Notice, SelectField } from '../vendor/nexui'

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

/** The account's time zone in the profile card, under the language (plan "Einstellungen", E14): a choice of every
 * zone, and the browser's own one click away when it differs. */
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
    <div className="flex flex-col gap-2">
      <SelectField
        label={t('zone.title')}
        value={current}
        hints={[t('zone.text')]}
        error={problem ?? undefined}
        data-testid="timezone"
        options={options.map((zone) => ({ value: zone, label: zone }))}
        onChange={(event) => save(event.target.value)}
      />
      {browser && browser !== current && (
        <Buttons>
          <Button kind="secondary" size="sm" icon="Globe" onClick={() => save(browser)} testId="timezone-browser">
            {t('zone.useBrowser', { zone: browser })}
          </Button>
        </Buttons>
      )}
      {saved && <Notice tone="ok">{t('zone.saved')}</Notice>}
    </div>
  )
}
