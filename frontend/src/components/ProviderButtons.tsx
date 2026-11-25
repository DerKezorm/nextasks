/**
 * The sign-in providers as buttons, in the order of the operator's list, with the line "or" above them: on the sign-in
 * page "Sign in with …", on the invitation page "Continue with …" (the invitation travels along to the provider).
 * Words from the shared sign-in module (`oidc.login.*`, `oidc.invite.button`), the same in every nex app; the look
 * from the shared kit (`OrLine`, and the button's kind and symbol from the account module's `BUTTONS`).
 */
import { useTranslation } from 'react-i18next'

import type { ProviderButton } from '../api/client'
import { OrLine } from '../vendor/nexui'
import { AccountButton } from './AccountButton'

/** Where a provider's button leads: its start, with the invitation or the page a direct link asked for. */
// eslint-disable-next-line react-refresh/only-export-components
export function startAddress(slug: string, { invite, next }: { invite?: string; next?: string } = {}): string {
  const query = new URLSearchParams()
  if (invite) query.set('invite', invite)
  if (next && next !== '/') query.set('next', next)
  const start = `/api/oidc/${encodeURIComponent(slug)}/start`
  return query.size ? `${start}?${query.toString()}` : start
}

export function ProviderButtons({
  providers,
  invite,
  next,
  withOr = true,
}: {
  providers: ProviderButton[]
  /** The invitation's key: the buttons say "Continue with" and take it along. */
  invite?: string
  /** The page a direct link asked for, to land on after the provider. */
  next?: string
  /** The line "or" above, when something stands before the buttons. */
  withOr?: boolean
}) {
  const { t } = useTranslation()
  if (providers.length === 0) return null
  return (
    <>
      {withOr && <OrLine>{t('oidc.login.or')}</OrLine>}
      <div className="flex flex-col gap-2" data-testid="provider-buttons">
        {providers.map((provider) => (
          <AccountButton key={provider.slug} name="oidc.login.button" wide onClick={() => window.location.assign(startAddress(provider.slug, { invite, next }))}>
            {invite ? t('oidc.invite.button', { name: provider.label }) : t('oidc.login.button', { name: provider.label })}
          </AccountButton>
        ))}
      </div>
    </>
  )
}
