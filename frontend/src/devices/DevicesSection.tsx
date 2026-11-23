/**
 * Settings, Connections: "Geräte", first, before the keys (as nexnotes' `devices/DevicesSection.tsx`). Every paired
 * iPhone and iPad with its name and its last contact, and "Trennen" after a question: the device reaches nothing from
 * that moment on. "iPhone oder iPad verbinden" opens the QR code (`ConnectDialog`).
 *
 * nextasks' server names no kind of device and nothing about notifications (`DeviceOut`: id, name, created_at,
 * last_seen), so every row has the phone's symbol and neither kind nor "Mitteilungen an".
 */
import { Smartphone } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '../components/ConfirmDialog'
import { Problem } from '../components/Field'
import { ago } from '../lib/time'
import { Card } from '../pages/settings/ui'
import { devicesApi, problemOf, type AppDevice } from './api'
import { ConnectDialog } from './ConnectDialog'

export function DevicesSection() {
  const { t, i18n } = useTranslation()
  const [devices, setDevices] = useState<AppDevice[] | null>(null)
  const [problem, setProblem] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [leaving, setLeaving] = useState<AppDevice | null>(null)

  // A list that cannot be read shows as empty, as before: the button to connect stays.
  const load = useCallback(() => devicesApi.list().then(setDevices, () => setDevices([])), [])
  useEffect(() => {
    void load()
  }, [load])

  const disconnect = async (device: AppDevice) => {
    setProblem('')
    try {
      await devicesApi.disconnect(device.id)
    } catch (error) {
      setProblem(problemOf(error))
    }
    await load()
  }

  return (
    <Card id="devices" icon={Smartphone} title={t('devices.section.title')} text={t('devices.section.text')}>
      <Problem text={problem} />
      {devices && devices.length === 0 && (
        <p className="text-sm text-mist-500" data-testid="devices-none">
          {t('devices.section.none')}
        </p>
      )}
      {devices && devices.length > 0 && (
        <ul className="flex flex-col" data-testid="devices-list">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="device-row">
              <Smartphone className="h-5 w-5 shrink-0 text-mist-300" strokeWidth={1.8} aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-mist-100" data-testid="device-name">
                  {device.name}
                </span>
                <span className="text-xs text-mist-500" data-testid="device-meta">
                  {device.last_seen ? t('devices.section.lastSeen', { when: ago(new Date(device.last_seen).getTime(), i18n.language) }) : t('devices.section.neverSeen')}
                </span>
              </span>
              <button type="button" className="nt-btn nt-btn-ghost" onClick={() => setLeaving(device)} aria-label={t('devices.section.disconnectName', { name: device.name })} data-testid="device-disconnect">
                {t('devices.section.disconnect')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="nt-btn nt-btn-accent" onClick={() => setConnecting(true)} data-testid="devices-connect">
          {t('devices.section.connect')}
        </button>
      </div>
      {connecting && (
        <ConnectDialog
          onClose={() => {
            setConnecting(false)
            void load()
          }}
        />
      )}
      {leaving && (
        <ConfirmDialog
          question={{
            title: t('devices.section.disconnectTitle', { name: leaving.name }),
            text: t('devices.section.disconnectText'),
            confirm: t('devices.section.disconnect'),
            run: () => void disconnect(leaving),
          }}
          onClose={() => setLeaving(null)}
        />
      )}
    </Card>
  )
}
