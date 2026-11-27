/**
 * Server › Sign-in (plan "Einstellungen", Anmeldung), the whole page from the shared modules: konten's `SignInPage`
 * (the emergency hammer's notice, "Ready for the internet?", the card "Sign-in") with the module oidc's
 * `SignInProviders` after it ("Sign-in providers", "authentik in one step"). nextasks hands over its words, its
 * server's answers and how it calls it; order, wording, kinds and sizes come from the modules.
 *
 * The switches go to `/api/server/sign-in` (the module's rules: the password sign-in off only with an active provider,
 * the second factor for everybody on only with an own one, off only with the password); the public address keeps its
 * own way (`PUT /api/settings`, the question when authentik knows the old one). Which points of "Ready for the
 * internet?" are open stays per device (`fold.ready`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, oidcApi, signInApi, type SignInSettingsView } from '../../api/client'
import { useDevicePref } from '../../lib/devicePref'
import { problemText } from '../../lib/errors'
import { useAuth } from '../../state/auth'
import type { Readiness } from '../../vendor/nexkonten/konten'
import { SignInPage, type AddressQuestion } from '../../vendor/nexkonten/SignInPage'
import { SignInProviders, type ErrorOf, type OidcAdminCalls, type OidcProviderForm, type OidcProviderRow } from '../../vendor/nexoidc/SignInProviders'

const APP = 'nextasks'

/** How the provider cards call nextasks' routes (the module oidc's under `/api`). */
const CALLS: OidcAdminCalls = {
  providers: () => oidcApi.providers() as unknown as Promise<OidcProviderRow[]>,
  add: (form: OidcProviderForm) => oidcApi.add(form as never),
  save: (id, form: OidcProviderForm) => oidcApi.save(Number(id), form as never),
  remove: (id) => oidcApi.remove(Number(id)),
  impact: (id, issuer) => oidcApi.impact(Number(id), issuer ?? '') as never,
  order: (ids) => oidcApi.order(ids.map(Number)),
  authentik: (url, token, confirm, publicUrl) => oidcApi.authentik(url, token, confirm, publicUrl) as never,
  authentikAddress: () => oidcApi.address() as never,
  authentikSaveAddress: (publicUrl, confirm) => oidcApi.saveAddress(publicUrl, confirm) as never,
}

/** A refusal as the module oidc reads it: the server's code and the values of the answer. */
// eslint-disable-next-line react-refresh/only-export-components
export const errorOf: ErrorOf = (error) => (error instanceof ApiError ? { code: error.code, values: error.values } : null)

export function SignInArea() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [view, setView] = useState<SignInSettingsView | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [opened, setOpened] = useDevicePref('fold.ready', (raw) => {
    try {
      const value = raw ? (JSON.parse(raw) as unknown) : {}
      return value && typeof value === 'object' ? (value as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const load = useCallback(async () => {
    const [found, ready] = await Promise.all([signInApi.read(), signInApi.readiness<Readiness>().catch(() => null)])
    setView(found)
    setReadiness(ready)
  }, [])
  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])
  const translate = useMemo(() => (key: string, values?: Record<string, unknown>) => t(key, values), [t])
  if (!view || !me) return null

  const saveAddress = async (url: string, confirm: boolean): Promise<AddressQuestion | null> => {
    try {
      await api('/api/settings', { method: 'PUT', body: { public_url: url, confirm_address: confirm } })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'public_url_change') {
        return { count: Number(error.values.count ?? 0), hand: Number(error.values.hand ?? 0), address: String(error.values.address ?? '') }
      }
      throw error
    }
    await load()
    return null
  }

  return (
    <SignInPage
      t={translate}
      app={APP}
      view={view}
      readiness={readiness}
      publicUrl={view.public_url}
      operatorHasPassword={me.sign_in === 'password'}
      onChange={async (change, password) => {
        setView(await signInApi.save(change, password ?? ''))
        setReadiness(await signInApi.readiness<Readiness>().catch(() => null))
      }}
      onSaveAddress={saveAddress}
      errorText={problemText}
      saved={t('settings.saved')}
      open={opened}
      onOpenChange={(key, open) => setOpened(JSON.stringify({ ...opened, [key]: open }))}
      providers={<SignInProviders t={translate} app={APP} apiPrefix="/api" calls={CALLS} errorOf={errorOf} publicUrl={view.public_url} onAddress={load} />}
    />
  )
}
