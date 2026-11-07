/**
 * nextasks as an installed app (`lib/pwa.ts`): the line "New version – reload" when a new version waits, the entry
 * "Install as app" in the account menu and under My account when the browser offers it, and on iPhone and iPad the
 * hint "Share › Add to Home Screen". In the installed app none of it shows but the new version.
 */
import { Download, RefreshCw, Share, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { install, takeUpdate, usePwa } from '../lib/pwa'
import { Logo } from './Logo'
import { Section } from './Section'

export function UpdateBanner() {
  const { t } = useTranslation()
  const { update } = usePwa()
  if (!update) return null
  return (
    <p role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent-500/30 bg-accent-500/10 px-4 py-2 text-sm text-mist-100" data-testid="update">
      <RefreshCw className="h-4 w-4 shrink-0 text-accent-400" aria-hidden />
      <span>{t('pwa.update')}</span>
      <button type="button" className="font-semibold text-accent-400 hover:underline" onClick={takeUpdate} data-testid="update-reload">
        {t('pwa.reload')}
      </button>
    </p>
  )
}

/** The entry in the account menu: a button where the browser offers to install, the hint on iPhone and iPad. */
export function InstallMenuItem({ className, onDone }: { className: string; onDone: () => void }) {
  const { t } = useTranslation()
  const { installable, ios, standalone } = usePwa()
  if (standalone) return null
  if (installable)
    return (
      <button
        type="button"
        className={className}
        data-testid="install-menu"
        onClick={() => {
          onDone()
          void install()
        }}
      >
        <Download className="h-4 w-4" strokeWidth={1.8} /> {t('pwa.install')}
      </button>
    )
  if (ios)
    return (
      <p className="flex items-start gap-2 px-3 py-2 text-xs text-mist-500" data-testid="install-ios">
        <Share className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden /> {t('pwa.iosHint')}
      </p>
    )
  return null
}

/** Under My account: what installing gives, and the button or the hint. Nothing when there is nothing to do. */
export function InstallSection() {
  const { t } = useTranslation()
  const { installable, ios, standalone } = usePwa()
  const [asked, setAsked] = useState(false)
  if (standalone || (!installable && !ios && !asked)) return null
  return (
    <Section icon={Download} title={t('pwa.title')}>
      <p className="mb-3 text-sm text-mist-400">{t('pwa.text')}</p>
      {installable && (
        <button
          type="button"
          className="nc-btn nc-btn-accent"
          data-testid="install"
          onClick={() => {
            setAsked(true)
            void install()
          }}
        >
          <Download className="h-4 w-4" /> {t('pwa.install')}
        </button>
      )}
      {!installable && ios && (
        <p className="flex items-start gap-2 text-sm text-mist-200" data-testid="install-ios">
          <Share className="mt-0.5 h-4 w-4 shrink-0 text-accent-400" aria-hidden /> {t('pwa.iosHint')}
        </p>
      )}
      {!installable && !ios && asked && <p className="text-sm text-mist-500">{t('pwa.asked')}</p>}
    </Section>
  )
}

/** The installed app started without network (or the server is down): no sign-in page for that. Asked again by
 * `state/auth.tsx` every few seconds and as soon as the network is back. */
export function OfflinePage({ retry }: { retry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="nt-safe flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center" data-testid="offline">
      <Logo withWordmark />
      <WifiOff className="h-8 w-8 text-mist-500" aria-hidden />
      <p className="max-w-sm text-sm text-mist-300">{t('pwa.offline')}</p>
      <button type="button" className="nc-btn nc-btn-ghost" onClick={retry}>
        {t('pwa.retry')}
      </button>
    </div>
  )
}
