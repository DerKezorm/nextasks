/**
 * The operator's part of Server › General (plan "Einstellungen", Allgemein), the cards in their order: "Grenzen" (the
 * largest file with its own save, location and device out of photos), "Funktionen für alle Konten" (invitations into
 * spaces), "Schnittstellen" (the module schluessel's, placed by `SettingsAreas`), "Sprachen" (built in, the operator's
 * own as chips, the template, upload by code). Built only from the ui kit. Everything here is the server's; it applies
 * to all.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, tabId, type AddressQuestion } from '../../api/client'
import { ENGLISH, own } from '../../i18n'
import { errorText } from '../../lib/errors'
import { LanguagesCard as ModuleLanguagesCard } from '../../vendor/nexsprachen/LanguagesCard'
import { Button, Card, CheckboxRow, Field, Notice } from '../../vendor/nexui'
import { Outcome, useAction } from './actions'

export type ServerSettings = {
  /** The iPhone app may use the server (off: 403 `app_disabled` for every device). */
  app_enabled: boolean
  /** New iPhones may be paired. */
  app_pairing_allowed: boolean
  /** Managers of a space may invite by link. */
  invites_enabled: boolean
  public_url: string
  password_login: boolean
  two_factor_required: boolean
  shares_allowed: boolean
  backup_schedule: 'off' | 'daily' | 'weekly'
  backup_keep: number
  smtp_host: string
  smtp_port: number
  smtp_security: 'starttls' | 'tls' | 'none'
  smtp_user: string
  smtp_password_set: boolean
  smtp_from: string
  /** The name the mails come from; empty: nextasks (post). */
  smtp_sender_name?: string
  /** Signing in with passkeys is allowed (on from the start). */
  passkeys_allowed?: boolean
  api_tokens_allowed: boolean
  upload_max_mb: number
  upload_ceiling_mb: number
  strip_location: boolean
  update_check: boolean
  /** Requests come with proxy headers, but no trusted proxy is set (read only). */
  proxy_unknown?: boolean
  /** The last mail the server took and its last failure (read only). */
  mail_last_ok_at?: string | null
  mail_last_error?: string
  mail_last_error_at?: string | null
}

type Change = Partial<ServerSettings> & { smtp_password?: string }
type Server = ReturnType<typeof useServerSettings>
/** The card that saved last: only it says how that went (both share one `useAction`). */
type Place = 'limits' | 'features'

// eslint-disable-next-line react-refresh/only-export-components
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  /** Why the settings could not be read (the server's code), shown with "Try again" instead of nothing. */
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const action = useAction()
  const reload = useCallback(() => {
    setLoadProblem(null)
    return api<ServerSettings>('/api/settings').then(setSettings, (error: unknown) => setLoadProblem(error instanceof ApiError ? error.code : 'internal_error'))
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  /** The switch moves at once; the server's answer confirms it, a refusal puts it back. Whether it was saved. */
  const save = async (change: Change, from: Place, done?: string): Promise<boolean> => {
    const before = settings
    setPlace(from)
    if (settings) setSettings({ ...settings, ...change })
    const ok = await action.run(async () => setSettings(await api<ServerSettings>('/api/settings', { method: 'PUT', body: change })), done)
    if (!ok) setSettings(before)
    return ok
  }
  /**
   * The public address, which the server asks about first when a provider knows a redirect address that would stay
   * behind (409 `public_url_change`): then nothing is saved and the question comes back, to be answered with
   * `confirm` (module 1.0.10). null: saved, or refused for another reason (`problem` says which).
   */
  const saveAddress = async (public_url: string, confirm = false): Promise<AddressQuestion | null> => {
    const asked: { question: AddressQuestion | null } = { question: null }
    const ok = await action.run(async () => {
      try {
        setSettings(await api<ServerSettings>('/api/settings', { method: 'PUT', body: { public_url, confirm_address: confirm } }))
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'public_url_change') throw error
        asked.question = { count: Number(error.values.count ?? 0), address: String(error.values.address ?? ''), hand: Number(error.values.hand ?? 0) }
      }
    })
    return ok ? asked.question : null
  }
  return { settings, loadProblem, place, save, saveAddress, reload, ...action }
}

/** Server › General when the settings could not be read: why, and a way to ask again without reloading the page. */
export function LoadProblem({ server }: { server: Server }) {
  const { t } = useTranslation()
  if (!server.loadProblem) return null
  return (
    <div className="flex flex-col items-start gap-2" data-testid="server-load-problem">
      <Notice tone="danger" title={t('server.loadFailed')}>
        {errorText(server.loadProblem)}
      </Notice>
      <Button kind="secondary" icon="RefreshCw" onClick={() => void server.reload()} testId="server-load-retry">
        {t('server.retry')}
      </Button>
    </div>
  )
}


/** "Grenzen": the largest file of an attachment (its own save) and what leaves a photo on upload. */
export function LimitsCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const [limit, setLimit] = useState<string | null>(null)
  const s = server.settings
  if (!s) return null
  return (
    <Card id="limits" icon="Gauge" title={t('server.limits')} subtitle={t('server.filesHint')}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          // A refused value stays in the field, to be sent again or corrected; only a saved one gives way to the server's.
          void server.save({ upload_max_mb: Math.max(1, Math.min(s.upload_ceiling_mb, Number(limit ?? s.upload_max_mb) || 1)) }, 'limits', t('settings.saved')).then((ok) => ok && setLimit(null))
        }}
      >
        <Field
          label={t('server.uploadMax')}
          type="number"
          min={1}
          max={s.upload_ceiling_mb}
          value={limit ?? String(s.upload_max_mb)}
          onChange={(event) => setLimit(event.target.value)}
          hints={[t('server.uploadCeiling', { mb: s.upload_ceiling_mb })]}
          data-testid="limits-upload-max"
          action={
            <Button kind="secondary" icon="Check" type="submit" busy={server.busy} testId="limits-upload-save">
              {t('common.save')}
            </Button>
          }
        />
      </form>
      <CheckboxRow label={t('server.stripLocation')} hint={t('server.stripLocationHint')} checked={s.strip_location} onChange={(strip_location) => void server.save({ strip_location }, 'limits')} testId="strip-location" />
      {server.place === 'limits' && <Outcome problem={server.problem} done={server.done} />}
    </Card>
  )
}

/** "Funktionen für alle Konten": what every account may use (invitations into spaces by link). */
export function FeaturesCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const s = server.settings
  if (!s) return null
  return (
    <Card id="features" icon="SlidersHorizontal" title={t('server.features')} subtitle={t('server.featuresHint')}>
      <CheckboxRow label={t('server.app.invites')} hint={t('server.app.invitesHint')} checked={s.invites_enabled !== false} onChange={(invites_enabled) => void server.save({ invites_enabled }, 'features')} testId="invites-enabled" />
      {server.place === 'features' && <Outcome problem={server.problem} done={server.done} />}
    </Card>
  )
}

/** The way of the card "Languages" to the server: as every call of nextasks, with the tab's name (changes without it
 * are refused) and the session's cookie. */
const languagesFetch = (path: string, init: RequestInit): Promise<Response> =>
  fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'X-Nextasks-Client': tabId() } })

/** "Sprachen": the shared module sprachen's card (plan "Einstellungen", Allgemein 5, E48, E51): the built-in ones and
 * the operator's own as chips, the template from nextasks' English texts, the language code with "Upload language".
 * After a change the menus ask the server again. */
export function LanguagesCard() {
  return <ModuleLanguagesCard app="nextasks" base="/api/locales" template={ENGLISH} fetcher={languagesFetch} onChange={own.forget} />
}
