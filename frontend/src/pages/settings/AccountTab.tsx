/**
 * Settings, "My account", as nexnotes' (`pages/settings/AccountTab.tsx` there): Profile (picture, display name, name,
 * role, mail address, the language, which travels to every device of the account; in nextasks the time zone and
 * installing as an app; at its end "Sign out" of this browser) and Security (one card: the providers, the password, the
 * second factor, signing out everywhere). Each area of the settings shows its `part`.
 */
import { KeyRound, Lock, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { api, ApiError, authApi, type Me, type MyProvider } from '../../api/client'
import { TimeZone } from '../../components/AccountParts'
import { InstallSection } from '../../components/AppInstall'
import { Avatar } from '../../components/Avatar'
import { Done, Field, Problem } from '../../components/Field'
import { changeLanguage, followBrowser, languageOptions, type LanguageOption } from '../../i18n'
import { copyText } from '../../lib/copy'
import { errorText, returnErrorText } from '../../lib/errors'
import { useAuth } from '../../state/auth'
import { Card, saveAsFile } from './ui'

const QUIET = 'nt-btn nt-btn-ghost h-8 px-3 text-xs font-medium'
const LOUD = 'nt-btn nt-btn-accent'
const PLAIN = 'nt-btn nt-btn-ghost'

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

/** The part of "My account" an area of the settings shows. */
export type AccountPart = 'profile' | 'security'

export function AccountTab({ part }: { part: AccountPart }) {
  const { t } = useTranslation()
  const { me, setMe, refresh } = useAuth()
  const [shownAs, setShownAs] = useState(me?.display_name ?? '')
  // The active sign-in providers and whether this account is linked to each: without one there is nothing to link.
  const [providers, setProviders] = useState<MyProvider[]>([])
  const loadProviders = () => authApi.myProviders().then(setProviders, () => setProviders([]))
  useEffect(() => {
    void loadProviders()
  }, [])
  /** The provider whose "Link" asks for the password now. */
  const [linking, setLinking] = useState<string | null>(null)
  const [params] = useSearchParams()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [linkPassword, setLinkPassword] = useState('')
  const [done, setDone] = useState<string | null>(null)
  // Back from linking: the provider by its name, never its short name (known once the list is there).
  const linkedSlug = params.get('linked')
  const linkedLabel = providers.find((entry) => entry.slug === linkedSlug)?.label
  const [linkedShown, setLinkedShown] = useState(!!linkedSlug)
  const shownDone = done ?? (linkedShown && linkedLabel ? t('me.linkedTo', { name: linkedLabel }) : null)
  const [problem, setProblem] = useState<string | null>(params.get('error') ? returnErrorText(params.get('error')!) : null)
  const [busy, setBusy] = useState(false)
  const [languages, setLanguages] = useState<LanguageOption[]>([])
  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setLanguages(list))
    return () => {
      alive = false
    }
  }, [])
  const picker = useRef<HTMLInputElement>(null)

  if (!me) return null

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    setLinkedShown(false)
    try {
      await action()
      setDone(success || null)
      await refresh()
    } catch (error) {
      setProblem(errorText(code(error)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div aria-live="polite">
        <Problem text={problem} />
        <Done text={shownDone} />
      </div>

      {part === 'profile' && (
        <Card id="profile" icon={UserRound} title={t('me.profile.title')}>
          <div className="flex flex-wrap items-center gap-3" data-testid="profile-picture">
            <Avatar person={me} className="h-14 w-14 text-2xl" />
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => picker.current?.click()} className={PLAIN}>
                  {me.avatar ? t('me.profile.change') : t('me.profile.upload')}
                </button>
                {me.avatar && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(async () => setMe(await api<Me>('/api/auth/avatar', { method: 'DELETE' })), t('me.profile.removed'))}
                    className={QUIET}
                  >
                    {t('me.profile.remove')}
                  </button>
                )}
              </div>
              <p className="text-xs text-mist-500">{t('me.profile.hint')}</p>
            </div>
            <input
              ref={picker}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif,image/avif,.heic,.heif"
              aria-label={t('me.profile.upload')}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void run(async () => setMe(await api<Me>('/api/auth/avatar', { method: 'PUT', raw: file })), t('me.profile.saved'))
              }}
            />
          </div>
          {/* How others see this account; the name below stays what one signs in with. */}
          <form
            className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                const saved = await authApi.profile(shownAs.trim())
                setShownAs(saved.display_name)
                setMe(saved)
              }, t('me.profile.displaySaved'))
            }}
          >
            <Field label={t('me.profile.displayName')} value={shownAs} onChange={setShownAs} autoComplete="name" hint={t(me.sign_in === 'password' ? 'me.profile.displayHintPassword' : 'me.profile.displayHint', { name: me.name })} />
            <button type="submit" disabled={busy || shownAs.trim() === (me.display_name ?? '')} className={LOUD + ' sm:mt-6'}>
              {t('me.profile.displaySave')}
            </button>
          </form>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm" data-testid="account-facts">
            <dt className="text-mist-500">{t('me.profile.name')}</dt>
            <dd className="text-mist-100">{me.name}</dd>
            {me.email && (
              <>
                <dt className="text-mist-500">{t('me.profile.email')}</dt>
                <dd className="break-all text-mist-100">{me.email}</dd>
              </>
            )}
          </dl>
          <p className="text-xs text-mist-500">{t('me.profile.roleLine', { role: t(`me.role.${me.role}`) })}</p>
          <label className="block text-sm">
            <span className="font-medium">{t('me.looks.language')}</span> <span className="text-xs text-mist-500">{t('me.looks.languageHint')}</span>
            <select
              className="nt-field mt-1"
              value={me.language}
              data-testid="language-select"
              onChange={(event) => {
                const chosen = event.target.value
                void run(async () => {
                  const saved = await authApi.language(chosen)
                  setMe(saved)
                  if (chosen) await changeLanguage(chosen)
                  else await followBrowser()
                }, '')
              }}
            >
              <option value="">{t('me.looks.browser')}</option>
              {languages.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.added ? `${option.name} ${t('me.looks.byOperator')}` : option.name}
                </option>
              ))}
            </select>
          </label>
        </Card>
      )}

      {part === 'profile' && (
        <>
          <TimeZone />
          <InstallSection />
          <SignOutCard viaProvider={me.sign_in === 'oidc'} />
        </>
      )}

      {part === 'security' && (
        <Card id="security" icon={ShieldCheck} title={t('me.security.title')}>
          {me.second_factor_setup_required && (
            <p role="note" className="rounded-[9px] border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm text-warn-500">
              {t('me.setupFirst')}
            </p>
          )}

          {/* Sign-in providers (the shared sign-in blueprint 04): a row per active provider with its state and "Link"
              or "Unlink". */}
          {(providers.length > 0 || me.sign_in === 'oidc') && (
            <div className="space-y-2">
              <p className="text-sm text-mist-400">{t('oidc.account.text')}</p>
              <ul className="divide-y divide-ink-700 rounded-[12px] border border-ink-700" data-testid="my-providers" aria-label={t('oidc.account.title')}>
                {providers.map((provider) => {
                  // The last link of an account without a password stays: it would lock the account out.
                  const lastLink = me.sign_in === 'oidc' && provider.linked && providers.filter((entry) => entry.linked).length === 1
                  return (
                    <li key={provider.slug} className="px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="min-w-0 flex-1 truncate font-medium text-mist-100">{provider.label}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${provider.linked ? 'bg-ok-500/10 text-ok-500' : 'border border-ink-700 text-mist-400'}`}>
                          {provider.linked ? t('oidc.account.linked') : t('oidc.account.notLinked')}
                        </span>
                        {provider.linked && !lastLink && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await authApi.unlink(provider.slug)
                                await loadProviders()
                              }, t('me.unlinkedFrom', { name: provider.label }))
                            }
                            className={QUIET}
                          >
                            {t('oidc.account.unlink')}
                          </button>
                        )}
                        {!provider.linked && me.sign_in === 'password' && linking !== provider.slug && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setLinking(provider.slug)
                              setLinkPassword('')
                            }}
                            className={QUIET}
                          >
                            {t('oidc.account.link')}
                          </button>
                        )}
                      </div>
                      {lastLink && <p className="mt-1 text-xs text-mist-500">{t('oidc.account.only', { name: provider.label })}</p>}
                      {linking === provider.slug && (
                        <form
                          className="mt-3 flex flex-wrap items-end gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            setBusy(true)
                            setProblem(null)
                            authApi.linkStart(provider.slug, linkPassword).then(
                              ({ url }) => window.location.assign(url),
                              (error) => {
                                setProblem(errorText(code(error)))
                                setBusy(false)
                              },
                            )
                          }}
                        >
                          <div className="min-w-48 flex-1">
                            <Field label={t('auth.password')} value={linkPassword} onChange={setLinkPassword} type="password" autoComplete="current-password" />
                          </div>
                          <button type="submit" disabled={busy} className={PLAIN}>
                            {t('oidc.account.link')}
                          </button>
                        </form>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {me.sign_in === 'password' && (
            <details className="rounded-[12px] border border-ink-700 px-3 py-2.5 text-sm" data-testid="password-row">
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <KeyRound className="h-4 w-4 text-mist-500" aria-hidden />
                <span className="flex-1 font-medium text-mist-100">{t('me.password.title')}</span>
                <span className={QUIET}>{t('me.password.change')}</span>
              </summary>
              <form
                className="mt-3 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!current) return setProblem(errorText('current_password_missing'))
                  if (!next) return setProblem(errorText('password_missing'))
                  if (next !== again) return setProblem(t('me.password.mismatch'))
                  void run(async () => {
                    await authApi.password(current, next)
                    setCurrent('')
                    setNext('')
                    setAgain('')
                  }, t('me.password.done'))
                }}
              >
                <Field label={t('me.password.current')} value={current} onChange={setCurrent} type="password" autoComplete="current-password" />
                <Field label={t('me.password.new')} value={next} onChange={setNext} type="password" autoComplete="new-password" hint={t('auth.passwordHint')} />
                <Field label={t('me.password.again')} value={again} onChange={setAgain} type="password" autoComplete="new-password" />
                <button type="submit" disabled={busy} className={LOUD}>
                  {t('me.password.submit')}
                </button>
              </form>
            </details>
          )}

          <div className="rounded-[12px] border border-ink-700 px-3 py-2.5">
            <h3 className="mb-2 text-sm font-medium text-mist-100">{t('twofactor.title')}</h3>
            <SecondFactor me={me} />
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-ink-700 px-3 py-2.5 text-sm">
            <Lock className="h-4 w-4 text-mist-500" aria-hidden />
            {/* At least 12rem wide: on a phone the button goes to the next line instead of squeezing the text into a
                column one word wide. */}
            <span className="min-w-0 grow basis-48 text-mist-300">{t('me.sessions.text')}</span>
            <button type="button" disabled={busy} onClick={() => void run(() => api('/api/auth/logout-all', { method: 'POST' }), t('me.sessions.done'))} className={QUIET}>
              {t('me.sessions.submit')}
            </button>
          </div>
        </Card>
      )}

      {/* While the second factor is still to be set up, Security is the only page open: the way out has to be here too. */}
      {part === 'security' && me.second_factor_setup_required && <SignOutCard viaProvider={me.sign_in === 'oidc'} />}
    </div>
  )
}

/**
 * "Sign out", the one button for it, here at the end of the profile as in nexnotes; on a phone the settings are the
 * same page. A provider's own session stays: only nextasks ends.
 */
function SignOutCard({ viaProvider }: { viaProvider: boolean }) {
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  return (
    <Card id="sign-out" icon={LogOut} title={t('me.signOut.title')} text={t('me.signOut.text')}>
      <div data-testid="sign-out-card" className="space-y-3">
        {viaProvider && <p className="text-xs text-mist-500">{t('me.signOut.provider')}</p>}
        <button type="button" className={PLAIN} data-testid="sign-out" onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}>
          {t('me.signOut.button')}
        </button>
      </div>
    </Card>
  )
}

/** Below this many recovery codes the account is told to make new ones. */
const LOW_CODES = 3

type Enrolment = { secret: string; uri: string; qr_svg: string }

/**
 * The second factor of the own account: set up (scan the code, type one code and the password), new recovery codes,
 * turn off. Recovery codes are shown once, right after they were made, to copy or save as a file.
 */
function SecondFactor({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null)
  const [asking, setAsking] = useState<'disable' | 'renew' | null>(null)
  const [digits, setDigits] = useState('')
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (me.sign_in !== 'password') return <p className="text-sm text-mist-400">{t('twofactor.provider')}</p>

  const close = () => {
    setEnrolment(null)
    setAsking(null)
    setDigits('')
    setPassword('')
    setProblem(null)
  }

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(errorText(code(error)))
    } finally {
      setBusy(false)
    }
  }

  const codesText = (codes ?? []).join('\n')

  return (
    <div className="space-y-3 text-sm" data-testid="second-factor">
      <p className="text-mist-400" data-testid="second-factor-lead">
        {t('twofactor.lead')}
      </p>
      {!enrolment && <Problem text={problem} />}

      {codes ? (
        <div className="space-y-3 rounded-[12px] border border-accent-500/40 bg-accent-500/10 p-3" data-testid="recovery-codes">
          <p className="font-semibold text-mist-100">{t('twofactor.codesTitle')}</p>
          <p className="text-xs text-mist-400">{t('twofactor.codesLead')}</p>
          <ol className="grid grid-cols-2 gap-2 rounded-[9px] bg-ink-950 px-4 py-3 font-mono text-sm text-mist-100">
            {codes.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => void copyText(codesText).then(setCopied)}>
              {copied ? t('common.copied') : t('twofactor.codesCopy')}
            </button>
            <button type="button" className={QUIET} onClick={() => saveAsFile(`nextasks-recovery-codes-${me.name}.txt`, new Blob([codesText + '\n'], { type: 'text/plain' }))}>
              {t('twofactor.codesDownload')}
            </button>
            <button
              type="button"
              className={LOUD}
              onClick={() => {
                setCodes(null)
                setCopied(false)
                void refresh()
              }}
            >
              {t('twofactor.codesDone')}
            </button>
          </div>
        </div>
      ) : enrolment ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              const result = await api<{ recovery_codes: string[] }>('/api/auth/totp/confirm', { method: 'POST', body: { code: digits.trim(), password } })
              close()
              setCodes(result.recovery_codes)
            })
          }}
        >
          <p className="text-mist-300">{t('twofactor.scan')}</p>
          <div className="flex justify-center">
            <img src={'data:image/svg+xml;utf8,' + encodeURIComponent(enrolment.qr_svg)} alt={t('twofactor.qr')} width={196} height={196} className="rounded-[9px] bg-white p-2" />
          </div>
          <p className="text-xs text-mist-500">{t('twofactor.secret')}</p>
          <code className="block rounded-[9px] bg-ink-950 px-3 py-2 font-mono text-xs break-all text-mist-200" data-testid="totp-secret">
            {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
          </code>
          <Field label={t('twofactor.code')} value={digits} onChange={setDigits} autoComplete="one-time-code" autoFocus />
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" hint={t('twofactor.passwordHint')} />
          <Problem text={problem} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className={PLAIN}>
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={busy || digits.trim().length !== 6 || !password} className={LOUD}>
              {t('twofactor.confirm')}
            </button>
          </div>
        </form>
      ) : asking ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              if (asking === 'disable') {
                await api('/api/auth/totp/disable', { method: 'POST', body: { password } })
                close()
                await refresh()
              } else {
                const result = await api<{ recovery_codes: string[] }>('/api/auth/totp/recovery', { method: 'POST', body: { password } })
                close()
                setCodes(result.recovery_codes)
              }
            })
          }}
        >
          <p className="text-mist-300">{asking === 'disable' ? t('twofactor.disableText') : t('twofactor.renewText')}</p>
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className={PLAIN}>
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={busy || !password} className={asking === 'disable' ? 'nt-btn nt-btn-danger' : LOUD}>
              {asking === 'disable' ? t('twofactor.disable') : t('twofactor.renew')}
            </button>
          </div>
        </form>
      ) : me.two_factor ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-mist-200">
            <ShieldCheck className="h-4 w-4 text-ok-500" />
            {t('twofactor.on', { count: me.two_factor_recovery_left })}
          </span>
          <button type="button" className={QUIET} onClick={() => setAsking('renew')}>
            {t('twofactor.renew')}
          </button>
          <button type="button" className={QUIET} onClick={() => setAsking('disable')}>
            {t('twofactor.disable')}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-mist-400">{t('twofactor.off')}</span>
          <button type="button" disabled={busy} className={LOUD} onClick={() => void act(async () => setEnrolment(await api<Enrolment>('/api/auth/totp/begin', { method: 'POST' })))}>
            {t('twofactor.enable')}
          </button>
        </div>
      )}
      {!codes && me.two_factor && me.two_factor_recovery_left < LOW_CODES && (
        <p role="note" className="rounded-[9px] border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
          {t('twofactor.lowCodes')}
        </p>
      )}
    </div>
  )
}

