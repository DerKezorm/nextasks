/**
 * My account › Connections: "Geräte", first, before the keys (as nexnotes' `devices/DevicesSection.tsx`). Every paired
 * iPhone and iPad with its name and its last contact, and "Trennen" after a question: the device reaches nothing from
 * that moment on. "iPhone oder iPad verbinden" opens the QR code (`ConnectDialog`).
 *
 * nextasks' server names no kind of device and nothing about notifications (`DeviceOut`: id, name, created_at,
 * last_seen), so every row has the phone's symbol and neither kind nor "Mitteilungen an".
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Problem } from '../components/Field'
import { ago } from '../lib/time'
import { Button, Buttons, Card, ConfirmDialog, Row, Rows } from '../vendor/nexui'
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
    <Card id="devices" icon="Smartphone" title={t('devices.section.title')} subtitle={t('devices.section.text')}>
      <Problem text={problem} />
      {devices && devices.length === 0 && (
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]" data-testid="devices-none">
          {t('devices.section.none')}
        </p>
      )}
      {devices && devices.length > 0 && (
        <Rows label={t('devices.section.title')} testId="devices-list">
          {devices.map((device) => (
            <Row
              key={device.id}
              icon="Smartphone"
              testId="device-row"
              name={<span data-testid="device-name">{device.name}</span>}
              sub={
                <span data-testid="device-meta">
                  {device.last_seen ? t('devices.section.lastSeen', { when: ago(new Date(device.last_seen).getTime(), i18n.language) }) : t('devices.section.neverSeen')}
                </span>
              }
              action={
                <Button kind="danger" size="sm" icon="Unplug" onClick={() => setLeaving(device)} aria-label={t('devices.section.disconnectName', { name: device.name })} testId="device-disconnect">
                  {t('devices.section.disconnect')}
                </Button>
              }
            />
          ))}
        </Rows>
      )}
      <Buttons>
        <Button kind="primary" icon="Smartphone" onClick={() => setConnecting(true)} testId="devices-connect">
          {t('devices.section.connect')}
        </Button>
      </Buttons>
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
          title={t('devices.section.disconnectTitle', { name: leaving.name })}
          text={t('devices.section.disconnectText')}
          confirm={{ label: t('devices.section.disconnect'), kind: 'danger', icon: 'Unplug' }}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          testId="confirm-dialog"
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            void disconnect(leaving)
            setLeaving(null)
          }}
        />
      )}
    </Card>
  )
}
