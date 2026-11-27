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
import { useAuth } from '../../state/auth'
import { WhatYouSeeCard } from '../../vendor/nexkonten/AccountCards'
import { MailCard } from '../../vendor/nexpost/MailCard'
import { mcpRequest, useMcpWords } from '../../lib/mcp'
import { useWhen } from '../../lib/useWhen'
import { DEVICES_BASE, deviceRequest, SERVER_CONNECTIONS_HREF } from '../../lib/devices'
import { McpOperatorSettings, PendingRequests, ToolRights } from '../../vendor/nexmcp'
import { AllKeysCard, ApiKeysCard, InterfacesCard, ToolsCard, type KeyRequest } from '../../vendor/nexschluessel'
import { ConnectionsArea as OtherApps, ConnectionsOperatorCard } from '../../vendor/nexverbinden'
import { DevicesCard } from '../../vendor/nexgeraete'
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
    case 'server-connections':
      return <ServerConnectionsArea />
    default:
      return <GeneralArea />
  }
}

/** Mein Konto › Connections: the iPhone app's devices (the device module's card), installing on this device, the
 * other nex apps that use the tasks (verbinden), the API keys, the AI tools (MCP: programs and MCP keys, their rights
 * per tool, the requests that wait). */
function ConnectionsArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const words = useMcpWords()
  const when = useWhen()
  return (
    <>
      <DevicesCard request={deviceRequest} base={DEVICES_BASE} app="nextasks" language={i18n.language} when={when} operator={me?.role === 'operator'} serverHref={SERVER_CONNECTIONS_HREF} />
      <InstallCard />
      <OtherApps app="nextasks" request={request} areaWord={t('mcp.areas')} language={i18n.language} when={when} operator={me?.role === 'operator'} />
      <ApiKeysCard request={request} things={t('settings.things')} thingsDative={t('settings.thingsDative')} words={{ areas: t('apiTokens.where') }} docsHref={API_DOCS} operator={me?.role === 'operator'} when={when} />
      <ToolsCard request={request} words={{ areas: t('apiTokens.where') }} when={when} extra={(key) => <ToolRights request={mcpRequest} keyId={key.id} words={words} />}>
        <PendingRequests request={mcpRequest} words={words} when={when} viewHref={(entry) => `/mcp/requests/${entry.id}`} />
      </ToolsCard>
    </>
  )
}

/** Server › General: limits, features for all accounts, languages. */
function GeneralArea() {
  const server = useServerSettings()
  if (!server.settings) return null
  return (
    <>
      <LimitsCard server={server} />
      <FeaturesCard server={server} />
      <LanguagesCard />
    </>
  )
}

/** Server › Connections (E67), the operator's mirror of My account › Connections: the other nex apps (verbinden), then
 * the interfaces (the module schluessel's: API, MCP with its settings, the iPhone app, pairing). */
function ServerConnectionsArea() {
  const words = useMcpWords()
  return (
    <>
      <ConnectionsOperatorCard app="nextasks" request={request} />
      <InterfacesCard request={request} docsHref={API_DOCS} after={{ mcp: <McpOperatorSettings request={mcpRequest} words={words} /> }} />
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
  const when = useWhen()
  return (
    <>
      <AccountsTab />
      <WhatYouSeeCard t={translate} text={t('server.whatYouSee')} />
      <AllKeysCard request={request} words={{ areas: t('apiTokens.where') }} when={when} />
    </>
  )
}
