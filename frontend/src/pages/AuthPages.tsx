/**
 * The pages before signing in, as nexnotes' (`pages/AuthPages.tsx` there): the first account (with the setup code from
 * the server's log), signing in (username or email and password, then the second factor; a passkey; or a provider's
 * button), a forgotten password, accepting an invitation (into a space, or the operator's into nextasks), setting a new
 * password with a link, and confirming a new address. Fields, their order and their words come from the shared account
 * module (`vendor/nexkonten`), the look from the shared kit (`vendor/nexui`: `AuthCard`, `Field`, `OrLine`,
 * `TextLink`); every button of the module through `AccountButton` (kind and symbol from `BUTTONS`).
 *
 * The sign-in providers follow the shared sign-in blueprint (part 04): below the password form the line "or" and a
 * button per active provider in the order of the operator's list; with the password sign-in off only the buttons, and
 * small at the bottom "Sign in as the operator with a password". The code step comes after a provider too, when that
 * provider is not trusted with the second factor (`?step=code`, the server parked the sign-in).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, api, authApi, invitesApi, resetApi, type InviteOffer, type Me, type Methods, type SetupState } from '../api/client'
import { AccountButton } from '../components/AccountButton'
import { Logo } from '../components/Logo'
import { PasswordConfirmField } from '../components/PasswordConfirm'
import { ProviderButtons } from '../components/ProviderButtons'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import i18n from '../i18n'
import { errorText, returnErrorText } from '../lib/errors'
import { passkeysSupported, signInWithPasskey } from '../lib/passkeys'
import { usePasswordConfirm } from '../lib/passwordConfirm'
import { safeNext, useAuth } from '../state/auth'
import {
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  fieldLabel,
  followUsername,
  normalizeUsername,
  PASSWORD_MIN,
  SETUP_PAGE,
  setupNotes,
  STAY_SIGNED_IN_DEFAULT,
  suggestUsername,
  USERNAME_MAX,
  usernameProblem,
} from '../vendor/nexkonten/konten'
import type { ButtonName } from '../vendor/nexkonten/konten'
import { AuthCard, Button, Checkbox, Field, Notice, TextLink } from '../vendor/nexui'
import { UpdateSetupRow } from '../vendor/nexupdates/UpdateSetupRow'

export function AuthFrame({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <div className="nt-safe nt-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo withWordmark />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-10">
        <AuthCard title={title} subtitle={text}>
          {children}
        </AuthCard>
      </main>
    </div>
  )
}

/** A field of the screens before signing in: the shared kit's `Field` (label joined by `htmlFor`, hints by
 * `aria-describedby`), with the value handed over as text. */
export function AuthField({ label, value, onChange, type = 'text', autoComplete, autoFocus = false, hint, maxLength, name }: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  autoComplete?: string
  autoFocus?: boolean
  hint?: string
  maxLength?: number
  name?: string
}) {
  return (
    <Field
      label={label}
      type={type}
      name={name}
      value={value}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      maxLength={maxLength}
      hints={hint ? [hint] : []}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** The one button of a screen, as wide as the card: kind and symbol from the module's table (`BUTTONS`). */
function Primary({ name, children, busy = false }: { name: ButtonName; children: ReactNode; busy?: boolean }) {
  return (
    <AccountButton name={name} type="submit" busy={busy} wide>
      {children}
    </AccountButton>
  )
}

/** A way back or on, as wide as the card (a link: the screens are pages of their own). */
function Onward({ to, kind = 'secondary', children }: { to: string; kind?: 'primary' | 'secondary'; children: ReactNode }) {
  return (
    <Button kind={kind} icon={kind === 'primary' ? 'ArrowRight' : 'ArrowLeft'} href={to} wide>
      {children}
    </Button>
  )
}

/** What went wrong: the server's code with the values its sentence needs ("at least {{minimum}} characters"). */
export type Trouble = { code: string; values?: Record<string, unknown> } | null

/** The refusal as a `Trouble`, values kept. */
// eslint-disable-next-line react-refresh/only-export-components
export function troubleOf(error: unknown): NonNullable<Trouble> {
  return error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error' }
}

/** A refusal; `returned`: the code came back in the address (`?error=`), where a code of the shared sign-in module
 * speaks only through its own sentence. */
export function Problem({ problem, returned = false }: { problem: Trouble; returned?: boolean }) {
  if (!problem) return null
  return <Notice tone="danger">{returned ? returnErrorText(problem.code) : errorText(problem.code, problem.values)}</Notice>
}

function Warning({ children }: { children: ReactNode }) {
  return <Notice tone="warn">{children}</Notice>
}

const codeOf = (error: unknown) => troubleOf(error).code

/** When the server cannot say which ways in there are: the password only, no button. */
const PASSWORD_ONLY: Methods = { password: true, providers: [] }

/** The ways in, or the password way when the answer fails. */
// eslint-disable-next-line react-refresh/only-export-components
export function waysIn(): Promise<Methods> {
  return authApi.methods().then(
    (methods) => ({ ...methods, providers: Array.isArray(methods.providers) ? methods.providers : [] }),
    () => PASSWORD_ONLY,
  )
}

/** The username field follows the display name until somebody types into it (the shared module's suggestion). */
function useUsername(displayName: string) {
  const [state, setState] = useState({ touched: false, username: '' })
  return {
    username: followUsername(state, displayName),
    setUsername: (value: string) => setState({ touched: true, username: value }),
  }
}

export function SetupPage() {
  const { t } = useTranslation()
  const { status, setMe } = useAuth()
  const [state, setState] = useState<SetupState | null>(null)
  const [name, setName] = useState('')
  const { username, setUsername } = useUsername(name)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const again = usePasswordConfirm(password)
  const [code, setCode] = useState('')
  // "Look for new versions" (updates U1): asked once at setup, ticked by default.
  const [updateCheck, setUpdateCheck] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)
  useEffect(() => {
    authApi.setupState().then(setState, () => undefined)
  }, [])
  if (status === 'loading') return null
  if (status !== 'setup') return <Navigate to="/" replace />
  const min = state?.min_password ?? PASSWORD_MIN
  return (
    <AuthFrame title={t(SETUP_PAGE.title)} text={t(SETUP_PAGE.subtitle)}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!name.trim()) return setProblem({ code: 'display_name_empty' })
          if (usernameProblem(username)) return setProblem({ code: 'username_invalid' })
          if (password.length < min) return setProblem({ code: 'password_too_short', values: { minimum: min } })
          setProblem(null)
          if (!again.matches()) return
          setBusy(true)
          try {
            setMe(
              await authApi.setup({
                display_name: name.trim(),
                name: normalizeUsername(username),
                email: email.trim(),
                password,
                password_confirm: again.confirm,
                code: code.trim(),
                // The language comes from the browser silently and is changed in the profile (konten: no field).
                language: i18n.language,
                update_check: updateCheck,
              }),
            )
          } catch (error) {
            setProblem(troubleOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Problem problem={problem} />
        <AuthField label={t('account.setupCode')} value={code} onChange={setCode} autoComplete="off" autoFocus hint={t('account.setupCodeHint')} />
        <AuthField label={t('account.displayName')} value={name} onChange={setName} autoComplete="name" maxLength={DISPLAY_NAME_MAX} hint={t('account.displayNameHint')} />
        <AuthField label={t('account.username')} value={username} onChange={setUsername} autoComplete="username" maxLength={USERNAME_MAX} hint={t('account.usernameHint')} />
        <AuthField label={t('account.email')} value={email} onChange={setEmail} type="email" autoComplete="email" maxLength={EMAIL_MAX} hint={t('account.emailHint')} />
        <AuthField label={t('account.newPassword')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('account.passwordRules', { minimum: min })} />
        <PasswordConfirmField value={again.confirm} onChange={again.setConfirm} mismatch={again.mismatch} />
        <UpdateSetupRow app="nextasks" checked={updateCheck} onChange={setUpdateCheck} language={i18n.language} />
        {/* No word about the second factor under the password unless one is required (konten 0.3.6): the first
            account comes before any switch of the operator. */}
        {setupNotes({ factorRequired: false }).map((note) => (
          <p key={note} className="m-0 text-sm">
            {t(note)}
          </p>
        ))}
        <Primary name="setupSubmit" busy={busy}>
          {t('auth.setup.submit')}
        </Primary>
      </form>
    </AuthFrame>
  )
}

export function LoginPage() {
  const { t } = useTranslation()
  const { status, setMe } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(STAY_SIGNED_IN_DEFAULT)
  const [step, setStep] = useState<'password' | 'code'>(params.get('step') === 'code' ? 'code' : 'password')
  const [passkeyStep, setPasskeyStep] = useState(false)
  /** False when a passkey is the only second step (no authenticator: there is no code to ask). */
  const [codeAsked, setCodeAsked] = useState(true)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(params.get('error') ? { code: params.get('error')! } : null)
  /** The problem shown came back from the provider in the address, not from a request of this page. */
  const [returned, setReturned] = useState(!!params.get('error'))
  // Password sign-in off: the form waits behind "Sign in as the operator with a password".
  const [operatorWay, setOperatorWay] = useState(false)
  /** Without a mail server "Forgot your password?" only says who can help. */
  const [forgot, setForgot] = useState(false)
  const next = safeNext(params.get('next'))
  /** Sent here from the open app whose session ended (blocked, signed out everywhere, E2). */
  const ended = params.get('ended') === '1'

  useEffect(() => {
    void waysIn().then(setMethods)
  }, [])

  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedIn') return <Navigate to={next} replace />
  // Nothing until the ways in are known: no password form that turns out not to be one.
  if (methods === null) return null

  const signedIn = async () => {
    setMe(await authApi.me())
    navigate(next, { replace: true })
  }

  const submit = async () => {
    if (step === 'password' && !name.trim()) return setProblem({ code: 'login_missing' })
    if (step === 'password' && !password) return setProblem({ code: 'password_missing' })
    setBusy(true)
    setProblem(null)
    setReturned(false)
    try {
      let answer: Me | { second_factor: true; passkey?: boolean; code?: boolean }
      if (step === 'code') answer = await authApi.code(code.trim())
      else answer = await authApi.login(name.trim(), password, remember)
      if ('second_factor' in answer) {
        setPassword('')
        setPasskeyStep(Boolean(answer.passkey) && passkeysSupported())
        setCodeAsked(answer.code !== false)
        setStep('code')
        return
      }
      await signedIn()
    } catch (error) {
      const found = troubleOf(error)
      setProblem(found)
      if (found.code === 'second_factor_expired' || found.code === 'sign_in_expired') {
        setStep('password')
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  const withPasskey = async () => {
    setBusy(true)
    setProblem(null)
    setReturned(false)
    try {
      await signInWithPasskey()
      await signedIn()
    } catch (error) {
      // The browser's own "cancelled" says nothing worth showing.
      if (error instanceof ApiError) setProblem(troubleOf(error))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code') {
    return (
      <AuthFrame title={t('auth.code.title')} text={codeAsked ? t('auth.code.text') : t('account.passkeysHint')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) void submit()
          }}
        >
          <Problem problem={problem} returned={returned} />
          {codeAsked && (
            <>
              <AuthField label={t('account.code')} value={code} onChange={setCode} autoComplete="one-time-code" autoFocus hint={t('account.codeHint')} />
              <Primary name="codeSubmit" busy={busy}>
                {t('auth.login.submit')}
              </Primary>
            </>
          )}
          {(passkeyStep || !codeAsked) && <AccountButton name="account.passkeySignIn" wide disabled={busy} onClick={() => void withPasskey()} />}
          <div className="text-center">
            <TextLink
              onClick={() => {
                void authApi.cancelCode().catch(() => undefined)
                setStep('password')
                setCode('')
                setProblem(null)
              }}
            >
              {t('auth.code.back')}
            </TextLink>
          </div>
        </form>
      </AuthFrame>
    )
  }

  const providers = methods.providers
  // Password sign-in off: only the buttons, the operator's form behind a small link (blueprint 04).
  const passwordShown = methods.password || providers.length === 0 || operatorWay
  const endedNote = ended && <Warning>{t('auth.login.ended')}</Warning>
  // "Sign in with a passkey" where the operator allows them and the browser can (a secure context: https or localhost).
  const passkeyShown = Boolean(methods.passkeys) && passkeysSupported()
  return (
    <AuthFrame title={t('auth.login.title')} text={t('auth.login.text')}>
      {passwordShown ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {endedNote}
          <Problem problem={problem} returned={returned} />
          <AuthField label={t('account.login')} value={name} onChange={setName} autoComplete="username" autoFocus name="name" maxLength={EMAIL_MAX} />
          <AuthField label={t('account.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" name="password" />
          <Checkbox label={t('account.stayIn')} checked={remember} onChange={setRemember} />
          <Primary name="signIn" busy={busy}>
            {t('auth.login.submit')}
          </Primary>
          <div className="text-center">
            {methods.forgot_mail ? (
              <TextLink href="/forgot">{t('account.forgot')}</TextLink>
            ) : (
              <TextLink onClick={() => setForgot(!forgot)}>{t('account.forgot')}</TextLink>
            )}
          </div>
          {!methods.forgot_mail && forgot && <p className="m-0 text-xs text-[var(--nexui-text-muted)]">{t('account.forgotNoMail')}</p>}
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          {endedNote}
          <Problem problem={problem} returned={returned} />
        </div>
      )}
      {passkeyShown && <AccountButton name="account.passkeySignIn" wide disabled={busy} onClick={() => void withPasskey()} />}
      <ProviderButtons providers={providers} next={next} withOr={passwordShown || passkeyShown} />
      {!passwordShown && (
        <div className="text-center">
          <TextLink onClick={() => setOperatorWay(true)}>{t('oidc.login.operator')}</TextLink>
        </div>
      )}
    </AuthFrame>
  )
}

/** "Forgot your password?" by mail: the same answer whatever was typed; without a mail server only the sentence. */
export function ForgotPage() {
  const { t } = useTranslation()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [name, setName] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)
  useEffect(() => {
    void waysIn().then(setMethods)
  }, [])
  if (methods === null) return null
  const back = <Onward to="/login">{t('auth.backToLogin')}</Onward>
  if (!methods.forgot_mail) {
    return (
      <AuthFrame title={t('account.forgotTitle')}>
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('account.forgotNoMail')}</p>
        {back}
      </AuthFrame>
    )
  }
  if (sent) {
    return (
      <AuthFrame title={t('account.forgotTitle')}>
        <Notice tone="ok">{t('account.forgotSent')}</Notice>
        {back}
      </AuthFrame>
    )
  }
  return (
    <AuthFrame title={t('account.forgotTitle')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!name.trim()) return setProblem({ code: 'login_missing' })
          setBusy(true)
          setProblem(null)
          try {
            await authApi.forgot(name.trim())
            setSent(true)
          } catch (error) {
            setProblem(troubleOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Problem problem={problem} />
        <AuthField label={t('account.login')} value={name} onChange={setName} autoComplete="username" autoFocus maxLength={EMAIL_MAX} />
        <Primary name="account.forgotSubmit" busy={busy}>
          {t('account.forgotSubmit')}
        </Primary>
      </form>
      {back}
    </AuthFrame>
  )
}

/** A link for a new password (the person's own, the operator's, or the server's emergency command): the person sets
 * a new password; nobody is signed in by it. */
export function ResetPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [offer, setOffer] = useState<{ name: string; username?: string; min_password: number } | null>(null)
  const [invalid, setInvalid] = useState<'invalid' | 'expired' | null>(null)
  const [password, setPassword] = useState('')
  const again = usePasswordConfirm(password)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)

  useEffect(() => {
    resetApi.offer(token).then(setOffer, (error) => setInvalid(codeOf(error) === 'reset_expired' ? 'expired' : 'invalid'))
  }, [token])

  if (invalid || done) {
    const key = done ? 'done' : invalid
    return (
      <AuthFrame title={t(`auth.reset.${key}Title`)}>
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t(`auth.reset.${key}Text`)}</p>
        <Onward to="/login" kind={done ? 'primary' : 'secondary'}>
          {t('auth.backToLogin')}
        </Onward>
      </AuthFrame>
    )
  }
  if (!offer) return null
  const min = offer.min_password || PASSWORD_MIN
  return (
    <AuthFrame title={t('account.resetTitle')} text={t('auth.reset.text', { name: offer.username || offer.name })}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (password.length < min) return setProblem({ code: 'password_too_short', values: { minimum: min } })
          setProblem(null)
          if (!again.matches()) return
          setBusy(true)
          try {
            await resetApi.use(token, password, again.confirm)
            setDone(true)
          } catch (error) {
            const found = troubleOf(error)
            if (found.code === 'reset_expired' || found.code === 'reset_invalid') setInvalid(found.code === 'reset_expired' ? 'expired' : 'invalid')
            else setProblem(found)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Problem problem={problem} />
        <AuthField label={t(fieldLabel('reset', 'newPassword'))} value={password} onChange={setPassword} type="password" autoComplete="new-password" autoFocus hint={t('account.passwordRules', { minimum: min })} />
        <PasswordConfirmField value={again.confirm} onChange={again.setConfirm} mismatch={again.mismatch} />
        <Primary name="resetSubmit" busy={busy}>
          {t('auth.reset.submit')}
        </Primary>
      </form>
    </AuthFrame>
  )
}

/**
 * A new account through an invitation (into a space, or the operator's into nextasks), as the shared module lays it
 * out: display name (from the invitation), username (the server's suggestion, then following the display name), the
 * address (from the invitation), the password twice; under it "or" and the providers.
 */
function NewAccountForm({ token, offer, methods, onDone }: { token: string; offer: InviteOffer; methods: Methods; onDone: (answer: Me & { space_id?: string | null }) => Promise<void> }) {
  const { t } = useTranslation()
  const [name, setName] = useState<string | null>(null)
  const [username, setUsername] = useState<{ touched: boolean; username: string }>({ touched: false, username: '' })
  const [email, setEmail] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const again = usePasswordConfirm(password)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)
  const shown = name ?? offer.display_name ?? ''
  // The suggestion of the server (from the invitation) until the display name is typed, then it follows that.
  const suggested = username.touched ? username.username : name === null ? (offer.name ?? '') : suggestUsername(shown)
  const address = email ?? offer.email ?? ''
  const min = offer.min_password || PASSWORD_MIN
  const passwordWay = offer.password !== false && methods.password
  return (
    <>
      {!passwordWay && methods.providers.length === 0 && <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('auth.invite.noWay')}</p>}
      {passwordWay && (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (busy) return
            if (!shown.trim()) return setProblem({ code: 'display_name_empty' })
            if (usernameProblem(suggested)) return setProblem({ code: 'username_invalid' })
            if (password.length < min) return setProblem({ code: 'password_too_short', values: { minimum: min } })
            setProblem(null)
            if (!again.matches()) return
            setBusy(true)
            try {
              const answer = await invitesApi.accept(token, {
                display_name: shown.trim(),
                name: normalizeUsername(suggested),
                email: address.trim(),
                password,
                password_confirm: again.confirm,
              })
              await onDone(answer)
            } catch (error) {
              setProblem(troubleOf(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          <Problem problem={problem} />
          <AuthField label={t('account.displayName')} value={shown} onChange={setName} autoComplete="name" autoFocus maxLength={DISPLAY_NAME_MAX} hint={t('account.displayNameHint')} />
          <AuthField
            label={t('account.username')}
            value={suggested}
            onChange={(value) => setUsername({ touched: true, username: value })}
            autoComplete="username"
            maxLength={USERNAME_MAX}
            hint={t('account.usernameHint')}
          />
          <AuthField label={t('account.email')} value={address} onChange={setEmail} type="email" autoComplete="email" maxLength={EMAIL_MAX} hint={t('account.emailHint')} />
          <AuthField label={t('account.newPassword')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('account.passwordRules', { minimum: min })} />
          <PasswordConfirmField value={again.confirm} onChange={again.setConfirm} mismatch={again.mismatch} />
          <Primary name="inviteSubmit" busy={busy}>
            {t('auth.invite.submit')}
          </Primary>
        </form>
      )}
      {/* Through a sign-in provider (a1-9, C9): the invitation is the permission for the new account. */}
      <ProviderButtons providers={methods.providers} invite={token} withOr={passwordWay} />
    </>
  )
}

/** An invitation into nextasks itself, made by the operator (or an older link into a space). */
function LegacyInvite({ token }: { token: string }) {
  const { t } = useTranslation()
  const { setMe, refresh } = useAuth()
  const navigate = useNavigate()
  const [offer, setOffer] = useState<InviteOffer | null>(null)
  /** Why the link does not hold: run out, or anything else (used, withdrawn, replaced) (Prüfgang G4). */
  const [invalid, setInvalid] = useState<'expired' | 'invalid' | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)
  const [methods, setMethods] = useState<Methods | null>(null)

  useEffect(() => {
    invitesApi.offer(token).then(setOffer, (error) => setInvalid(codeOf(error) === 'invite_expired' ? 'expired' : 'invalid'))
    void waysIn().then(setMethods)
  }, [token])

  if (invalid) {
    return (
      <AuthFrame title={invalid === 'expired' ? t('auth.invite.expiredTitle') : t('auth.invite.invalidTitle')}>
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{invalid === 'expired' ? t('auth.invite.expiredText') : t('auth.invite.invalidText')}</p>
        <Onward to="/login">{t('auth.backToLogin')}</Onward>
      </AuthFrame>
    )
  }
  // The ways in first, as on the sign-in page: no password form that turns out not to be one.
  if (!offer || methods === null) return null
  // Who invites, so the link is not taken for spam (E18).
  const by = offer.by ? 'By' : ''
  const text = offer.space ? t(`auth.invite.intoSpace${by}`, { space: offer.space, role: t(`roles.${offer.role}`), by: offer.by }) : t(`auth.invite.intoApp${by}`, { by: offer.by })

  if (offer.signed_in_as && !offer.space) {
    // A link for a new account, opened by somebody signed in already: there is nothing to join (F2).
    return (
      <AuthFrame title={t('auth.invite.title')} text={t('auth.invite.haveAccount', { name: offer.signed_in_as })}>
        <Onward to="/" kind="primary">
          {t('auth.invite.toApp')}
        </Onward>
      </AuthFrame>
    )
  }

  if (offer.signed_in_as) {
    return (
      <AuthFrame title={t('auth.invite.title')} text={text}>
        <Problem problem={problem} />
        <AccountButton
          name="confirm"
          wide
          busy={busy}
          onClick={async () => {
            // Once: a second click while the first is under way would only meet the used link.
            if (busy) return
            setBusy(true)
            try {
              await api(`/api/invite/${encodeURIComponent(token)}/join`, { method: 'POST' })
              await refresh()
              navigate('/', { replace: true })
            } catch (error) {
              setProblem(troubleOf(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('auth.invite.join', { name: offer.signed_in_as })}
        </AccountButton>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('auth.invite.title')} text={text}>
      <NewAccountForm
        token={token}
        offer={offer}
        methods={methods}
        onDone={async (answer) => {
          setMe(answer)
          navigate(answer.space_id ? `/?space=${encodeURIComponent(answer.space_id)}` : '/', { replace: true })
        }}
      />
    </AuthFrame>
  )
}

type SpaceInvite = { space_name: string; invited_by: string | null; expires_at: string; already_member: boolean; signed_in: boolean }

/**
 * `/invite/<secret>`: an invitation into a space (contract, "Bereiche und Mitglieder"), also without being signed in.
 * Signed in, one button takes it; without an account one makes one here (as the shared module lays it out) or goes on
 * with a sign-in provider; who has an account signs in first. A link the space invitations do not know may be the
 * operator's invitation into nextasks itself.
 */
export function InvitePage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const { refresh, status } = useAuth()
  const navigate = useNavigate()
  const [invite, setInvite] = useState<SpaceInvite | 'legacy' | 'unknown' | null>(null)
  const [offer, setOffer] = useState<InviteOffer | null>(null)
  const [methods, setMethods] = useState<Methods | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)

  useEffect(() => {
    api<SpaceInvite>(`/api/invites/${encodeURIComponent(token)}`).then(
      (found) => {
        setInvite(found)
        // The fields of a new account as the shared module fills them (display name, username, address).
        if (!found.signed_in) invitesApi.offer(token).then(setOffer, () => setInvite('unknown'))
      },
      (error) => {
        if (codeOf(error) !== 'invite_unknown') return setInvite('unknown')
        // Not a space invitation: perhaps the operator's invitation into nextasks.
        invitesApi.offer(token).then(
          () => setInvite('legacy'),
          () => setInvite('unknown'),
        )
      },
    )
    void waysIn().then(setMethods)
  }, [token])

  if (invite === 'legacy') return <LegacyInvite token={token} />
  if (invite === 'unknown') {
    return (
      <AuthFrame title={t('join.unknownTitle')}>
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('join.unknownText')}</p>
        <Onward to="/login">{t('auth.backToLogin')}</Onward>
      </AuthFrame>
    )
  }
  if (!invite || methods === null || status === 'loading') return null
  const text = invite.invited_by ? t('join.textBy', { space: invite.space_name, name: invite.invited_by }) : t('join.text', { space: invite.space_name })

  if (invite.signed_in) {
    return (
      <AuthFrame title={t('join.title')} text={text}>
        <Problem problem={problem} />
        {invite.already_member ? (
          <Onward to="/" kind="primary">
            {t('join.already')}
          </Onward>
        ) : (
          <AccountButton
            name="confirm"
            wide
            busy={busy}
            onClick={async () => {
              if (busy) return
              setBusy(true)
              setProblem(null)
              try {
                const done = await api<{ space_id: string }>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' })
                await refresh()
                navigate(`/?space=${encodeURIComponent(done.space_id)}`, { replace: true })
              } catch (error) {
                setProblem(troubleOf(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('join.accept')}
          </AccountButton>
        )}
      </AuthFrame>
    )
  }

  if (!offer) return null
  return (
    <AuthFrame title={t('join.title')} text={text}>
      <NewAccountForm
        token={token}
        offer={offer}
        methods={methods}
        onDone={async (answer) => {
          await refresh()
          navigate(answer.space_id ? `/?space=${encodeURIComponent(answer.space_id)}` : '/', { replace: true })
        }}
      />
      <div className="text-center">
        <TextLink href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>{t('join.signIn')}</TextLink>
      </div>
    </AuthFrame>
  )
}

/**
 * `/app-connect?device=<name>`: the iPhone app opened this page to be connected through the browser's sign-in.
 * "Connect iPhone" asks the server for the app's link and hands over to the app.
 */
export function AppConnectPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const device = (params.get('device') ?? '').slice(0, 80)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Trouble>(null)
  const [link, setLink] = useState<string | null>(null)
  return (
    <AuthFrame title={t('connect.title')} text={device ? t('connect.textNamed', { device }) : t('connect.text')}>
      <Problem problem={problem} />
      <AccountButton
        name="confirm"
        wide
        busy={busy}
        testId="app-connect"
        onClick={async () => {
          setBusy(true)
          setProblem(null)
          try {
            const answer = await api<{ link: string }>('/api/app-connect', { method: 'POST', body: { device } })
            // Only the app's own scheme: the page never sends anyone elsewhere.
            if (!answer.link.startsWith('nextasks://')) throw new ApiError(500, 'internal_error')
            setLink(answer.link)
            window.location.assign(answer.link)
          } catch (error) {
            setProblem(troubleOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('connect.button')}
      </AccountButton>
      {link && (
        <p className="m-0 text-center text-xs text-[var(--nexui-text-muted)]">
          {t('connect.notOpened')} <TextLink href={link}>{t('connect.again')}</TextLink>
        </p>
      )}
      <div className="text-center">
        <TextLink href="/">{t('connect.skip')}</TextLink>
      </div>
    </AuthFrame>
  )
}

/**
 * `/confirm-email/<token>`: the link from the mail that confirms an address. Works without being signed in (the link
 * is the proof); it is taken once, on purpose by the page, not by opening it (`POST /api/email/confirm`). The address
 * lives in the profile now, so the way on leads there.
 */
export function ConfirmEmailPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [email, setEmail] = useState<string | null>(null)
  const [problem, setProblem] = useState<Trouble>(null)
  // A link works once: asked once per token, also when React runs the effect twice.
  const asked = useRef('')
  useEffect(() => {
    if (asked.current === token) return
    asked.current = token
    api<{ email: string }>('/api/email/confirm', { method: 'POST', body: { token } }).then(
      (answer) => setEmail(answer.email),
      (error) => setProblem(troubleOf(error)),
    )
  }, [token])
  return (
    <AuthFrame title={t('confirmEmail.title')}>
      <Problem problem={problem} />
      {!problem && !email && <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('confirmEmail.busy')}</p>}
      {email && (
        <Notice tone="ok" testId="confirmed">
          {t('confirmEmail.done', { email })}
        </Notice>
      )}
      <Onward to="/settings/profile">{t('confirmEmail.toProfile')}</Onward>
    </AuthFrame>
  )
}

/**
 * `/unsubscribe/<token>`: the link at the foot of a report or event. It asks first, so that a program that opens every
 * link of a mail turns nothing off; mail programs post to the server's address in `List-Unsubscribe` themselves.
 */
export function UnsubscribePage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [found, setFound] = useState<{ event: string; channel: string; on: boolean } | null>(null)
  const [problem, setProblem] = useState<Trouble>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const path = `/api/notify/unsubscribe/${encodeURIComponent(token)}`
  useEffect(() => {
    api<{ event: string; channel: string; on: boolean }>(path).then(setFound, (error) => setProblem(troubleOf(error)))
  }, [path])
  const event = found ? t(found.event === 'daily' || found.event === 'weekly' ? `notify.${found.event}` : `notify.events.${found.event}`) : ''
  const channel = found ? t(`notify.channels.${found.channel}`, { defaultValue: found.channel }) : ''
  return (
    <AuthFrame title={t('unsubscribe.title')}>
      <Problem problem={problem} />
      {found && !done && (
        <>
          <p className="m-0 text-sm">{found.on ? t('unsubscribe.ask', { event, channel }) : t('unsubscribe.already', { event, channel })}</p>
          {found.on && (
            <AccountButton
              name="confirm"
              wide
              busy={busy}
              testId="unsubscribe"
              onClick={() => {
                setBusy(true)
                api(path, { method: 'POST' })
                  .then(
                    () => setDone(true),
                    (error) => setProblem(troubleOf(error)),
                  )
                  .finally(() => setBusy(false))
              }}
            >
              {t('unsubscribe.button')}
            </AccountButton>
          )}
        </>
      )}
      {done && <Notice tone="ok">{t('unsubscribe.done')}</Notice>}
      <Onward to="/settings/notifications">{t('unsubscribe.toSettings')}</Onward>
    </AuthFrame>
  )
}
