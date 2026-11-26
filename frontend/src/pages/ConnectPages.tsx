/**
 * The pages of connections with other nex apps (shared module verbinden 0.1.1), both only for a signed-in browser:
 *
 * - `/connect/app`: another nex app (nexmail, nextime …) asks to use the account's tasks; the module's `ConsentPage`
 *   with what each side may, the spaces, "Verbinden erlauben" and "Ablehnen".
 * - `/connect/return`: back from another app's consent page; the module's `ReturnPage` finishes the connection and
 *   goes on to My account › Connections.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../api/client'
import { Logo } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { ConsentPage, ReturnPage, type VerbindenRequest } from '../vendor/nexverbinden'

const request: VerbindenRequest = <T,>(path: string, init: Parameters<VerbindenRequest>[1] = {}) => api<T>(path, init)

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="nt-safe nt-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo withWordmark />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-10">{children}</main>
    </div>
  )
}

export function ConnectConsentPage() {
  const { t, i18n } = useTranslation()
  return (
    <Frame>
      <ConsentPage request={request} areaWord={t('mcp.areas')} language={i18n.language} />
    </Frame>
  )
}

export function ConnectReturnPage() {
  const { i18n } = useTranslation()
  return (
    <Frame>
      <ReturnPage app="nextasks" request={request} language={i18n.language} />
    </Frame>
  )
}
