/**
 * nextasks as an installed app (`lib/pwa.ts`): the line "New version – reload" when a new version waits, and the page
 * without network. Installing has its card under Settings › Connections (`InstallCard.tsx`).
 */
import { RefreshCw, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { takeUpdate, usePwa } from '../lib/pwa'
import { Logo } from './Logo'

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

/** The installed app started without network (or the server is down): no sign-in page for that. Asked again by
 * `state/auth.tsx` every few seconds and as soon as the network is back. */
export function OfflinePage({ retry }: { retry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="nt-safe flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center" data-testid="offline">
      <Logo withWordmark />
      <WifiOff className="h-8 w-8 text-mist-500" aria-hidden />
      <p className="max-w-sm text-sm text-mist-300">{t('pwa.offline')}</p>
      <button type="button" className="nt-btn nt-btn-ghost" onClick={retry}>
        {t('pwa.retry')}
      </button>
    </div>
  )
}
