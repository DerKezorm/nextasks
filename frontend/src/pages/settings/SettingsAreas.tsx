/**
 * What each area of the settings shows, as nexnotes' (`SettingsAreas.tsx` there): the cards as they were in the tabs
 * and the account page before, only sorted by subject. The cards themselves stay in their files (`AccountTab`,
 * `LookCards`, `ServerCards`, `SignInCards`, `AboutArea`, `components/…`); an area only picks them.
 */
import { ApiTokens } from '../../components/ApiTokens'
import { NotificationsPart } from '../../components/Notifications'
import { DevicesSection } from '../../devices/DevicesSection'
import { AboutArea } from './AboutArea'
import { AccountTab } from './AccountTab'
import type { AreaSlug } from './areas'
import { LookCards } from './LookCards'
import { AccountsCard, AllApiTokensCard, ApiTokensSwitchCard, AppCard, BackupsCard, FilesCard, LanguagesCard, LogCard, MailCard, ProxyHint, useServerSettings } from './ServerCards'
import { SignInPart } from './SignInCards'

type ServerArea = 'general' | 'sign-in' | 'mail' | 'storage' | 'accounts'

export function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
    case 'security':
      return <AccountTab part={area} />
    case 'appearance':
      return <LookCards />
    case 'connections':
      return (
        <div className="space-y-6">
          {/* "Geräte" first, before the keys, as in nexnotes. */}
          <DevicesSection />
          <ApiTokens />
        </div>
      )
    case 'notifications':
      return <NotificationsPart />
    case 'log':
      return <LogCard />
    case 'about':
      return <AboutArea />
    default:
      return <ServerCardsOf area={area} />
  }
}

/**
 * The server's own settings, for the operator. The hint about an unnamed proxy concerns the sign-in brake and the
 * addresses: it stands in General and in Sign-in, as in nexnotes.
 */
function ServerCardsOf({ area }: { area: ServerArea }) {
  const server = useServerSettings()
  return (
    <div className="space-y-6" data-testid={`server-${area}`}>
      {(area === 'general' || area === 'sign-in') && <ProxyHint />}
      {area === 'general' && (
        <>
          <FilesCard server={server} />
          <ApiTokensSwitchCard server={server} />
          <AppCard server={server} />
          <LanguagesCard />
        </>
      )}
      {area === 'sign-in' && <SignInPart server={server} />}
      {area === 'mail' && <MailCard server={server} />}
      {area === 'storage' && <BackupsCard server={server} />}
      {area === 'accounts' && (
        <>
          <AccountsCard />
          <AllApiTokensCard />
        </>
      )}
    </div>
  )
}
