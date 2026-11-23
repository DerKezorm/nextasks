/**
 * "iPhone oder iPad verbinden", as nexnotes' (`devices/ConnectDialog.tsx` there): the QR code with three steps,
 * "Gilt 10 Minuten · neu erzeugen", and for a device without a camera the address with the short code, which the app
 * takes under "Code". The code pairs one device; the dialog asks every two seconds whether it was taken and closes
 * itself then. A code that ran out says so and is made anew with one click; closing the dialog withdraws a code nobody
 * took. The operator's switches stay the server's: with the app or pairing switched off it refuses, and the dialog
 * says why.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Problem } from '../components/Field'
import { devicesApi, problemOf, qrSource, type Pairing } from './api'

/** How often the dialog asks whether the code was taken. */
export const POLL_MS = 2000

export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [expired, setExpired] = useState(false)
  const [problem, setProblem] = useState('')
  const current = useRef<Pairing | null>(null)
  const used = useRef(false)

  const make = useCallback(async () => {
    setProblem('')
    const before = current.current
    if (before) void devicesApi.withdraw(before.id).catch(() => undefined)
    try {
      const made = await devicesApi.pair()
      current.current = made
      setPairing(made)
      setExpired(false)
    } catch (error) {
      setProblem(problemOf(error))
    }
  }, [])

  // One pairing per opening, also when React runs the effect twice.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void make()
  }, [make])

  const close = useCallback(() => {
    const left = current.current
    if (left && !used.current) void devicesApi.withdraw(left.id).catch(() => undefined)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!pairing || expired) return
    const timer = window.setInterval(() => {
      if (new Date(pairing.expires_at).getTime() <= Date.now()) {
        setExpired(true)
        return
      }
      devicesApi.state(pairing.id).then(
        (found) => {
          if (current.current?.id !== pairing.id) return
          if (found.state === 'connected') {
            used.current = true
            onClose()
          } else if (found.state === 'expired') setExpired(true)
        },
        () => undefined,
      )
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pairing, expired, onClose])

  const host = pairing ? hostOf(pairing.address) : ''
  return (
    <Dialog title={t('devices.connect.title')} onClose={close} wide>
      <div className="flex flex-wrap gap-6" data-testid="devices-connect-dialog">
        <div className="flex w-[220px] flex-none flex-col items-center gap-2.5">
          <div className="h-[220px] w-[220px] rounded-[12px] bg-white p-3.5">
            {pairing && !expired && <img src={qrSource(pairing.qr_svg)} alt={t('devices.connect.qr')} className="h-full w-full" data-testid="devices-qr" />}
            {expired && (
              <p className="flex h-full items-center justify-center text-center text-sm text-[#15202b]" data-testid="devices-expired">
                {t('devices.connect.expired')}
              </p>
            )}
          </div>
          <span className="text-xs text-mist-500">
            {t('devices.connect.valid')} ·{' '}
            <button type="button" className="text-accent-400 hover:underline" onClick={() => void make()} data-testid="devices-renew">
              {t('devices.connect.renew')}
            </button>
          </span>
        </div>
        <div className="flex min-w-[240px] flex-1 flex-col gap-3.5">
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-mist-300">
            <li>{t('devices.connect.step1')}</li>
            <li>{t('devices.connect.step2')}</li>
            <li>{t('devices.connect.step3')}</li>
          </ol>
          {pairing && !expired && (
            <p className="rounded-[10px] border border-ink-700 bg-ink-900 px-3.5 py-3 text-[13px] leading-relaxed text-mist-400" data-testid="devices-address">
              <Trans
                i18nKey="devices.connect.noCamera"
                values={{ host, code: pairing.code }}
                components={{ b: <strong className="text-mist-100" />, code: <strong className="font-mono tracking-wider text-mist-100" data-testid="devices-code" /> }}
              />
            </p>
          )}
          <Problem text={problem} />
          <div className="flex justify-end">
            <button type="button" className="nt-btn nt-btn-ghost" onClick={close} data-testid="devices-close">
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/** The address as one types it into the app's field, which starts with "https://"; a plain http address stays whole. */
function hostOf(address: string): string {
  return address.replace(/^https:\/\//, '').replace(/\/$/, '')
}
