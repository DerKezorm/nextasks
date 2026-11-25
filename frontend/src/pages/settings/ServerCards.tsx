/**
 * The operator's part of Server › General (plan "Einstellungen", Allgemein), the cards in their order: "Grenzen" (the
 * largest file with its own save, location and device out of photos), "Funktionen für alle Konten" (invitations into
 * spaces), "Schnittstellen" (the module schluessel's, placed by `SettingsAreas`), "Sprachen" (built in, the operator's
 * own as chips, the template, upload by code). Built only from the ui kit. Everything here is the server's; it applies
 * to all.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, type AddressQuestion } from '../../api/client'
import { byLanguageName, forgetAddedLanguages, SHIPPED, templateFile } from '../../i18n'
import { Button, Buttons, Card, CheckboxRow, Chip, Field } from '../../vendor/nexui'
import { Outcome, saveAsFile, useAction } from './actions'

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

// eslint-disable-next-line react-refresh/only-export-components
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const action = useAction()
  const reload = useCallback(() => api<ServerSettings>('/api/settings').then(setSettings, () => undefined), [])
  useEffect(() => {
    void reload()
  }, [reload])
  /** The switch moves at once; the server's answer confirms it, a refusal puts it back. */
  const save = async (change: Change, done?: string) => {
    const before = settings
    if (settings) setSettings({ ...settings, ...change })
    const ok = await action.run(async () => setSettings(await api<ServerSettings>('/api/settings', { method: 'PUT', body: change })), done)
    if (!ok) setSettings(before)
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
  return { settings, save, saveAddress, reload, ...action }
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
          void server.save({ upload_max_mb: Math.max(1, Math.min(s.upload_ceiling_mb, Number(limit ?? s.upload_max_mb) || 1)) }, t('settings.saved')).then(() => setLimit(null))
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
      <CheckboxRow label={t('server.stripLocation')} hint={t('server.stripLocationHint')} checked={s.strip_location} onChange={(strip_location) => void server.save({ strip_location })} testId="strip-location" />
      <Outcome problem={server.problem} done={server.done} />
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
      <CheckboxRow label={t('server.app.invites')} hint={t('server.app.invitesHint')} checked={s.invites_enabled !== false} onChange={(invites_enabled) => void server.save({ invites_enabled })} testId="invites-enabled" />
      <Outcome problem={server.problem} done={server.done} />
    </Card>
  )
}

type Locale = { code: string; name: string; keys: number }

/** "Sprachen": the built-in ones and the operator's own as chips (by name, decided 06.10.2026), the template, upload. */
export function LanguagesCard() {
  const { t } = useTranslation()
  const [list, setList] = useState<Locale[]>([])
  const [code, setCode] = useState('')
  const action = useAction()
  const load = useCallback(() => {
    api<Locale[]>('/api/locales').then(setList, () => undefined)
  }, [])
  useEffect(load, [load])
  const upload = (chosen: File) =>
    void action.run(async () => {
      await api(`/api/locales/${encodeURIComponent(code)}`, { method: 'PUT', raw: chosen })
      forgetAddedLanguages()
      load()
    }, t('server.languageAdded'))
  return (
    <Card id="languages" icon="Globe" title={t('server.languages')} subtitle={t('server.languagesHint')}>
      <div className="flex flex-wrap gap-2" data-testid="languages-list">
        {byLanguageName([
          ...Object.entries(SHIPPED).map(([shipped, entry]) => ({ code: shipped, name: entry.name, keys: 0, shipped: true })),
          ...list.map((entry) => ({ ...entry, shipped: false })),
        ]).map((entry) =>
          entry.shipped ? (
            <Chip key={`shipped-${entry.code}`}>{`${entry.name} · ${t('server.builtIn')}`}</Chip>
          ) : (
            <Chip
              key={entry.code}
              name={entry.name}
              disabled={action.busy}
              testId={`language-${entry.code}`}
              onRemove={() =>
                void action.run(async () => {
                  await api(`/api/locales/${entry.code}`, { method: 'DELETE' })
                  forgetAddedLanguages()
                  load()
                })
              }
            >
              {`${entry.name} (${entry.code}) · ${t('server.texts', { count: entry.keys })}`}
            </Chip>
          ),
        )}
      </div>
      <Buttons>
        <Button kind="secondary" icon="Download" onClick={() => saveAsFile('nextasks-language-template.json', templateFile())} testId="language-template">
          {t('server.template')}
        </Button>
      </Buttons>
      <Field
        label={t('server.languageCode')}
        value={code}
        onChange={(event) => setCode(event.target.value.trim())}
        placeholder="es"
        data-testid="language-code"
        action={
          <Button kind="secondary" icon="Upload" disabled={!code} busy={action.busy} accept="application/json,.json" onFile={upload} testId="language-upload">
            {t('server.upload')}
          </Button>
        }
      />
      <Outcome problem={action.problem} done={action.done} />
    </Card>
  )
}
