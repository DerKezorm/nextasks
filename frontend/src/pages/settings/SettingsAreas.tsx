/**
 * What each area of the settings shows, in the order of the plan "Einstellungen": only cards. The cards stay in their
 * files (`AccountTab`, `AppearanceArea`, `components/Notifications`, `devices/`, `ServerCards`, `SignInArea`,
 * `StorageArea`, `AccountsTab`, `LogCard`, `AboutArea`) or come from the shared modules; an area only picks them.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../../api/client'
import { InstallCard } from '../../components/InstallCard'
import { NotificationsPart } from '../../components/Notifications'
import { DevicesSection } from '../../devices/DevicesSection'
import { useAuth } from '../../state/auth'
import { WhatYouSeeCard } from '../../vendor/nexkonten/AccountCards'
import { MailCard } from '../../vendor/nexpost/MailCard'
import { AllKeysCard, ApiKeysCard, InterfacesCard, type KeyRequest } from '../../vendor/nexschluessel'
import { AboutArea } from './AboutArea'
import { AccountsTab } from './AccountsTab'
import { AccountTab } from './AccountTab'
import { AppearanceArea } from './AppearanceArea'
import type { AreaSlug } from './areas'
import { LogCard } from './LogCard'
import { FeaturesCard, LanguagesCard, LimitsCard, useServerSettings } from './ServerCards'
import { SignInArea } from './SignInArea'
import { StorageArea } from './StorageArea'

/** Where `/api/v1` is described: `docs/api.md` of the repository. */
const API_DOCS = 'https://github.com/DerKezorm/nextasks/blob/main/docs/api.md'

/** nextasks' client for the modules' cards (its tab header, its errors). */
const request: KeyRequest = <T,>(path: string, init: Parameters<KeyRequest>[1] = {}) => api<T>(path, init)

export function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
    case 'security':
      return <AccountTab part={area} />
    case 'appearance':
      return <AppearanceArea />
    case 'notifications':
      return <NotificationsPart />
    case 'connections':
      return <ConnectionsArea />
    case 'sign-in':
      return <SignInArea />
    case 'mail':
      return <MailArea />
    case 'storage':
      return <StorageArea />
    case 'accounts':
      return <AccountsArea />
    case 'log':
      return <LogCard />
    case 'about':
      return <AboutArea />
    default:
      return <GeneralArea />
  }
}

/** Mein Konto › Connections: the iPhone app's devices, installing on this device, the API keys (no MCP in nextasks). */
function ConnectionsArea() {
  const { t } = useTranslation()
  const { me } = useAuth()
  return (
    <>
      <DevicesSection />
      <InstallCard />
      <ApiKeysCard request={request} things={t('settings.things')} words={{ areas: t('apiTokens.where') }} docsHref={API_DOCS} operator={me?.role === 'operator'} />
    </>
  )
}

/** Server › General: limits, features for all accounts, interfaces (the module schluessel's), languages. */
function GeneralArea() {
  const server = useServerSettings()
  if (!server.settings) return null
  return (
    <>
      <LimitsCard server={server} />
      <FeaturesCard server={server} />
      <InterfacesCard request={request} docsHref={API_DOCS} />
      <LanguagesCard />
    </>
  )
}

/** Server › Mail: the card of the module post, with nextasks' sentence of every mail it sends. */
function MailArea() {
  const { t } = useTranslation()
  const mailRequest = useMemo(() => request, [])
  return <MailCard request={mailRequest as never} subtitle={t('server.mailText')} senderPlaceholder="tasks@example.com" />
}

/** Server › Accounts: the module's list, "Was du siehst", the API keys of all accounts. */
function AccountsArea() {
  const { t } = useTranslation()
  const translate = useMemo(() => (key: string, values?: Record<string, unknown>) => t(key, values), [t])
  return (
    <>
      <AccountsTab />
      <WhatYouSeeCard t={translate} text={t('server.whatYouSee')} />
      <AllKeysCard request={request} words={{ areas: t('apiTokens.where') }} />
    </>
  )
}
