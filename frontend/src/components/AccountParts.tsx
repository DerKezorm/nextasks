/**
 * Parts of the own account that belong to the new nextasks: the time zone (due times are meant in it) and the iPhone
 * app (pairing by QR code or code, the devices signed in). Notifications in this browser (web push) moved to
 * "Notifications" (`components/Notifications.tsx`), as the channel "Browser".
 */
import { Clock3, QrCode, Smartphone, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError } from '../api/client'
import { errorText } from '../lib/errors'
import { moment } from '../lib/time'
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
        <select aria-label={t('zone.title')} className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-mist-100" value={current} onChange={(e) => save(e.target.value)} data-testid="timezone">
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        {browser && browser !== current && (
          <button type="button" className="nc-btn nc-btn-ghost" onClick={() => save(browser)}>
            {t('zone.useBrowser', { zone: browser })}
          </button>
        )}
      </div>
      {saved && <p className="mt-2 text-xs text-ok-500">{t('zone.saved')}</p>}
      {problem && <p className="mt-2 text-xs text-bad-500">{problem}</p>}
    </Section>
  )
}

type Device = { id: string; name: string; created_at: string; last_seen: string | null }
type Pairing = { id: string; code: string; expires_at: string; address: string; link: string; qr_svg: string }

export function AppDevices() {
  const { t, i18n } = useTranslation()
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [state, setState] = useState<'waiting' | 'connected' | 'expired' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => api<Device[]>('/api/app-devices').then(setDevices, () => setDevices([])), [])
  useEffect(() => {
    void load()
  }, [load])

  // While a pairing waits, ask every two seconds whether the iPhone took it.
  useEffect(() => {
    if (!pairing || state !== 'waiting') return
    const timer = setInterval(() => {
      api<{ state: 'waiting' | 'connected' | 'expired' }>(`/api/app-pairing/${pairing.id}`).then(
        (answer) => {
          setState(answer.state)
          if (answer.state === 'connected') void load()
        },
        () => undefined,
      )
    }, 2000)
    return () => clearInterval(timer)
  }, [pairing, state, load])

  const start = async () => {
    setProblem(null)
    try {
      const made = await api<Pairing>('/api/app-pairing', { method: 'POST', body: { address: window.location.origin } })
      setPairing(made)
      setState('waiting')
    } catch (error) {
      setProblem(errorText(codeOf(error)))
    }
  }
  const stop = async () => {
    if (pairing) await api(`/api/app-pairing/${pairing.id}`, { method: 'DELETE' }).catch(() => undefined)
    setPairing(null)
    setState(null)
  }

  return (
    <Section icon={Smartphone} title={t('device.title')}>
      <p className="mb-3 text-sm text-mist-400">{t('device.text')}</p>
      {!pairing && (
        <button type="button" className="nc-btn nc-btn-accent" onClick={() => void start()} data-testid="pair-start">
          <QrCode className="h-4 w-4" /> {t('device.connect')}
        </button>
      )}
      {pairing && (
        <div className="flex flex-wrap items-start gap-5 rounded-2xl border border-ink-700 bg-ink-850 p-4" data-testid="pairing">
          {/* The server draws the code; shown as a picture, never as markup in the page. */}
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qr_svg)}`} alt={t('device.qr')} className="h-44 w-44 rounded-xl bg-white p-2" />
          <div className="min-w-48 flex-1 space-y-2 text-sm">
            {state === 'connected' ? (
              <p className="text-ok-500">{t('device.done')}</p>
            ) : state === 'expired' ? (
              <p className="text-warn-500">{t('device.expired')}</p>
            ) : (
              <>
                <p className="text-mist-300">{t('device.scan')}</p>
                <p className="text-mist-400">{t('device.orCode')}</p>
                <p className="font-mono text-2xl font-bold tracking-widest text-mist-100" data-testid="pair-code">
                  {pairing.code}
                </p>
                <p className="text-xs text-mist-500">{t('device.until', { when: moment(pairing.expires_at, i18n.language) })}</p>
              </>
            )}
            <button type="button" className="nc-btn nc-btn-ghost" onClick={() => void stop()}>
              {state === 'waiting' ? t('common.cancel') : t('common.close')}
            </button>
          </div>
        </div>
      )}
      {problem && <p className="mt-2 text-sm text-bad-500">{problem}</p>}
      <h3 className="mt-5 mb-2 text-sm font-semibold text-mist-100">{t('device.list')}</h3>
      {devices?.length === 0 && <p className="text-sm text-mist-500">{t('device.none')}</p>}
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700 empty:hidden" data-testid="devices">
        {(devices ?? []).map((device) => (
          <li key={device.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
            <Smartphone className="h-4 w-4 text-mist-500" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-mist-100">{device.name}</span>
              <span className="text-xs text-mist-500">{device.last_seen ? t('device.seen', { when: moment(device.last_seen, i18n.language) }) : t('device.since', { when: moment(device.created_at, i18n.language) })}</span>
            </span>
            <button type="button" className="nc-btn nc-btn-ghost text-bad-500" aria-label={t('device.removeName', { name: device.name })} onClick={() => void api(`/api/app-devices/${device.id}`, { method: 'DELETE' }).then(load, (error) => setProblem(errorText(codeOf(error))))}>
              <Trash2 className="h-3.5 w-3.5" /> {t('device.remove')}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}
