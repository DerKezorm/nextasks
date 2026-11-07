/**
 * The pages before signing in, as in nexlore: the first account (with the setup code from the server's log),
 * signing in (password, then the second factor; or a provider's button), and accepting an invitation.
 *
 * The sign-in providers follow the shared sign-in blueprint (part 04): below the password form the line "or" and a
 * button per active provider in the order of the operator's list; with the password sign-in off only the buttons, and
 * small at the bottom "Sign in as the operator with a password". The code step comes after a provider too, when that
 * provider is not trusted with the second factor (`?step=code`, the server parked the sign-in).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, api, authApi, type Me, type Methods } from '../api/client'
import { Logo } from '../components/Logo'
import { ProviderButtons } from '../components/ProviderButtons'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import i18n from '../i18n'
import { errorText, returnErrorText } from '../lib/errors'
import { safeNext, useAuth } from '../state/auth'

function AuthFrame({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <div className="nt-safe nc-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo withWordmark />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-10">
        <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-xl">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {text && <p className="mt-1 text-sm text-mist-500">{text}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </main>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', autoComplete, autoFocus = false, hint }: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  autoComplete?: string
  autoFocus?: boolean
  hint?: string
}) {
  const hintId = useId()
  return (
    <div className="text-sm">
      <label className="block">
        <span className="font-medium">{label}</span>
        <input
          type={type}
          value={value}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-edge bg-ink-850 px-3 text-sm outline-none focus:border-accent-500"
        />
      </label>
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-mist-500">
          {hint}
        </span>
      )}
    </div>
  )
}

function Primary({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <button type="submit" disabled={busy} className="h-10 w-full rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-600 disabled:opacity-50">
      {children}
    </button>
  )
}

/** A refusal; `returned`: the code came back in the address (`?error=`), where a code of the shared sign-in module
 * speaks only through its own sentence. */
function Problem({ code, returned = false }: { code: string | null; returned?: boolean }) {
  if (!code) return null
  return (
    <p role="alert" className="rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
      {returned ? returnErrorText(code) : errorText(code)}
    </p>
  )
}

/** When the server cannot say which ways in there are: the password only, no button. */
const NO_PROVIDERS: Methods = { password: true, providers: [] }

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : 'internal_error')

export function SetupPage() {
  const { t } = useTranslation()
  const { status, setMe } = useAuth()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (status === 'loading') return null
  if (status !== 'setup') return <Navigate to="/" replace />
  return (
    <AuthFrame title={t('auth.setup.title')} text={t('auth.setup.text')}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!name.trim()) return setProblem('name_missing')
          setBusy(true)
          setProblem(null)
          try {
            setMe(await authApi.setup(name.trim(), password, code.trim(), i18n.language))
          } catch (error) {
            setProblem(codeOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Problem code={problem} />
        <Field label={t('auth.setup.code')} value={code} onChange={setCode} autoFocus hint={t('auth.setup.codeHint')} />
        <Field label={t('auth.name')} value={name} onChange={setName} autoComplete="username" />
        <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('auth.passwordHint')} />
        <Primary busy={busy}>{t('auth.setup.submit')}</Primary>
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
  const [step, setStep] = useState<'password' | 'code'>(params.get('step') === 'code' ? 'code' : 'password')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(params.get('error'))
  /** The problem shown came back from the provider in the address, not from a request of this page. */
  const [returned, setReturned] = useState(!!params.get('error'))
  // Password sign-in off: the form waits behind "Sign in as the operator with a password".
  const [operatorWay, setOperatorWay] = useState(false)
  const next = safeNext(params.get('next'))
  /** Sent here from the open app whose session ended (blocked, signed out everywhere, E2). */
  const ended = params.get('ended') === '1'

  useEffect(() => {
    void authApi.methods().then(setMethods, () => setMethods(NO_PROVIDERS))
  }, [])

  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedIn') return <Navigate to={next} replace />
  // Nothing until the ways in are known: no password form that turns out not to be one.
  if (methods === null) return null

  const submit = async () => {
    if (step === 'password' && !name.trim()) return setProblem('name_missing')
    if (step === 'password' && !password) return setProblem('password_missing')
    setBusy(true)
    setProblem(null)
    setReturned(false)
    try {
      let answer: Me | { second_factor: true }
      if (step === 'code') answer = await authApi.code(code.trim())
      else answer = await authApi.login(name.trim(), password)
      if ('second_factor' in answer) {
        setPassword('')
        setStep('code')
        return
      }
      setMe(await authApi.me())
      navigate(next, { replace: true })
    } catch (error) {
      const found = codeOf(error)
      setProblem(found)
      if (found === 'second_factor_expired') {
        setStep('password')
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code') {
    return (
      <AuthFrame title={t('auth.code.title')} text={t('auth.code.text')}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) void submit()
          }}
        >
          <Problem code={problem} returned={returned} />
          <Field label={t('auth.code.label')} value={code} onChange={setCode} autoComplete="one-time-code" autoFocus hint={t('auth.code.hint')} />
          <Primary busy={busy}>{t('auth.login.submit')}</Primary>
          <button
            type="button"
            className="w-full text-center text-xs text-mist-500 hover:text-mist-300"
            onClick={() => {
              void authApi.cancelCode().catch(() => undefined)
              setStep('password')
              setCode('')
              setProblem(null)
            }}
          >
            {t('auth.code.back')}
          </button>
        </form>
      </AuthFrame>
    )
  }

  const providers = methods.providers
  // Password sign-in off: only the buttons, the operator's form behind a small link (blueprint 04).
  const passwordShown = methods.password || providers.length === 0 || operatorWay
  return (
    <AuthFrame title={t('auth.login.title')} text={t('auth.login.text')}>
      {ended && <p className="mb-4 rounded-xl border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-xs text-mist-200">{t('auth.login.ended')}</p>}
      {passwordShown ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Problem code={problem} returned={returned} />
          <Field label={t('auth.name')} value={name} onChange={setName} autoComplete="username" autoFocus />
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" />
          <Primary busy={busy}>{t('auth.login.submit')}</Primary>
        </form>
      ) : (
        <Problem code={problem} returned={returned} />
      )}
      <div className={passwordShown ? '' : 'mt-1'}>
        <ProviderButtons providers={providers} next={next} withOr={passwordShown} />
      </div>
      {!passwordShown && (
        <p className="mt-5 text-center text-xs text-mist-600">
          <button type="button" className="hover:text-mist-300" onClick={() => setOperatorWay(true)}>
            {t('oidc.login.operator')}
          </button>
        </p>
      )}
    </AuthFrame>
  )
}

type InviteState = { space: string | null; role: string | null; min_password: number; signed_in_as: string | null; by?: string | null }

/** An invitation into nextasks itself, made by the operator (the older kind, still kept by the server). */
function LegacyInvite({ token }: { token: string }) {
  const { t } = useTranslation()
  const { setMe, refresh } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<InviteState | null>(null)
  /** Why the link does not hold: run out, or anything else (used, withdrawn, replaced) (Prüfgang G4). */
  const [invalid, setInvalid] = useState<'expired' | 'invalid' | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [methods, setMethods] = useState<Methods | null>(null)

  useEffect(() => {
    api<InviteState>(`/api/invite/${encodeURIComponent(token)}`).then(setState, (error) => {
      const code = codeOf(error)
      setInvalid(code === 'invite_expired' ? 'expired' : 'invalid')
    })
    authApi.methods().then(setMethods, () => setMethods(NO_PROVIDERS))
  }, [token])

  if (invalid) {
    return (
      <AuthFrame title={invalid === 'expired' ? t('auth.invite.expiredTitle') : t('auth.invite.invalidTitle')}>
        <p className="text-sm text-mist-400">{invalid === 'expired' ? t('auth.invite.expiredText') : t('auth.invite.invalidText')}</p>
        <BackLink />
      </AuthFrame>
    )
  }
  // The ways in first, as on the sign-in page: no password form that turns out not to be one.
  if (!state || methods === null) return null
  // Who invites, so the link is not taken for spam (E18).
  const by = state.by ? 'By' : ''
  const text = state.space ? t(`auth.invite.intoSpace${by}`, { space: state.space, role: t(`roles.${state.role}`), by: state.by }) : t(`auth.invite.intoApp${by}`, { by: state.by })

  if (state.signed_in_as && !state.space) {
    // A link for a new account, opened by somebody signed in already: there is nothing to join (F2).
    return (
      <AuthFrame title={t('auth.invite.title')} text={t('auth.invite.haveAccount', { name: state.signed_in_as })}>
        <Link to="/" className="nc-btn nc-btn-accent flex h-10 w-full items-center justify-center">
          {t('auth.invite.toApp')}
        </Link>
      </AuthFrame>
    )
  }

  if (state.signed_in_as) {
    return (
      <AuthFrame title={t('auth.invite.title')} text={text}>
        <Problem code={problem} />
        <button
          type="button"
          disabled={busy}
          className="h-10 w-full rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-600 disabled:opacity-50"
          onClick={async () => {
            // Once: a second click while the first is under way would only meet the used link.
            if (busy) return
            setBusy(true)
            try {
              await api(`/api/invite/${encodeURIComponent(token)}/join`, { method: 'POST' })
              await refresh()
              navigate('/', { replace: true })
            } catch (error) {
              setProblem(codeOf(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('auth.invite.join', { name: state.signed_in_as })}
        </button>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('auth.invite.title')} text={text}>
      {!methods.password && methods.providers.length === 0 && <p className="text-sm text-mist-400">{t('auth.invite.noWay')}</p>}
      {methods.password && (
        <>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setProblem(null)
            try {
              setMe(await api<Me>(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST', body: { name: name.trim(), password } }))
              navigate('/', { replace: true })
            } catch (error) {
              setProblem(codeOf(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          <Problem code={problem} />
          {/* The rule up front, not after the first refusal (E18). */}
          <Field label={t('auth.invite.name')} value={name} onChange={setName} autoComplete="username" autoFocus hint={t('auth.invite.nameHint')} />
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('auth.passwordHint')} />
          <Primary busy={busy}>{t('auth.invite.submit')}</Primary>
        </form>
        </>
      )}
      {/* Through a sign-in provider (a1-9, C9): the invitation is the permission for the new account. */}
      <ProviderButtons providers={methods.providers} invite={token} withOr={methods.password} />
    </AuthFrame>
  )
}

/** The way back from a page behind a link that does not hold (G3). */
function BackLink() {
  const { t } = useTranslation()
  return (
    <Link to="/login" className="nc-btn nc-btn-ghost mt-4 flex h-10 w-full items-center justify-center">
      {t('auth.backToLogin')}
    </Link>
  )
}

type SpaceInvite = { space_name: string; invited_by: string | null; expires_at: string; already_member: boolean; signed_in: boolean }

/**
 * `/invite/<secret>`: an invitation into a space (contract, "Bereiche und Mitglieder"), also without being signed in.
 * Signed in, one button takes it; without an account one makes one here (name and password) or goes on with a
 * sign-in provider; who has an account signs in first. A link the space invitations do not know may be an older
 * invitation into nextasks itself.
 */
export function InvitePage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const { refresh, status } = useAuth()
  const navigate = useNavigate()
  const [invite, setInvite] = useState<SpaceInvite | 'legacy' | 'unknown' | null>(null)
  const [methods, setMethods] = useState<Methods | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    api<SpaceInvite>(`/api/invites/${encodeURIComponent(token)}`).then(setInvite, (error) => {
      if (codeOf(error) !== 'invite_unknown') return setInvite('unknown')
      // Not a space invitation: perhaps the operator's invitation into nextasks.
      api(`/api/invite/${encodeURIComponent(token)}`).then(
        () => setInvite('legacy'),
        () => setInvite('unknown'),
      )
    })
    authApi.methods().then(setMethods, () => setMethods(NO_PROVIDERS))
  }, [token])

  if (invite === 'legacy') return <LegacyInvite token={token} />
  if (invite === 'unknown') {
    return (
      <AuthFrame title={t('join.unknownTitle')}>
        <p className="text-sm text-mist-400">{t('join.unknownText')}</p>
        <BackLink />
      </AuthFrame>
    )
  }
  if (!invite || methods === null || status === 'loading') return null

  /** Signed in: take it. Without an account: make one with it (`POST /api/invite/{secret}`, the older path). */
  const accept = async (account?: { name: string; password: string }) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const done = account
        ? await api<{ space_id: string }>(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST', body: account })
        : await api<{ space_id: string }>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' })
      await refresh()
      navigate(`/?space=${encodeURIComponent(done.space_id)}`, { replace: true })
    } catch (error) {
      setProblem(codeOf(error))
    } finally {
      setBusy(false)
    }
  }
  const text = invite.invited_by ? t('join.textBy', { space: invite.space_name, name: invite.invited_by }) : t('join.text', { space: invite.space_name })

  if (invite.signed_in) {
    return (
      <AuthFrame title={t('join.title')} text={text}>
        <Problem code={problem} />
        {invite.already_member ? (
          <Link to="/" className="nc-btn nc-btn-accent flex h-10 w-full items-center justify-center">
            {t('join.already')}
          </Link>
        ) : (
          <button type="button" disabled={busy} onClick={() => void accept()} className="h-10 w-full rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-600 disabled:opacity-50">
            {t('join.accept')}
          </button>
        )}
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('join.title')} text={text}>
      {!methods.password && methods.providers.length === 0 && <p className="text-sm text-mist-400">{t('auth.invite.noWay')}</p>}
      {methods.password && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return setProblem('name_missing')
            if (!password) return setProblem('password_missing')
            void accept({ name: name.trim(), password })
          }}
        >
          <Problem code={problem} />
          <Field label={t('auth.invite.name')} value={name} onChange={setName} autoComplete="username" autoFocus hint={t('auth.invite.nameHint')} />
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('auth.passwordHint')} />
          <Primary busy={busy}>{t('join.create')}</Primary>
        </form>
      )}
      <ProviderButtons providers={methods.providers} invite={token} withOr={methods.password} />
      <p className="mt-5 text-center text-xs text-mist-500">
        <Link to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="font-medium text-accent-400 hover:underline">
          {t('join.signIn')}
        </Link>
      </p>
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
  const [problem, setProblem] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  return (
    <AuthFrame title={t('connect.title')} text={device ? t('connect.textNamed', { device }) : t('connect.text')}>
      <Problem code={problem} />
      <button
        type="button"
        disabled={busy}
        data-testid="app-connect"
        className="h-10 w-full rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-600 disabled:opacity-50"
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
            setProblem(codeOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('connect.button')}
      </button>
      {link && (
        <p className="mt-4 text-center text-xs text-mist-500">
          {t('connect.notOpened')}{' '}
          <a href={link} className="font-medium text-accent-400 hover:underline">
            {t('connect.again')}
          </a>
        </p>
      )}
      <p className="mt-4 text-center text-xs text-mist-600">
        <Link to="/" className="hover:text-mist-300">
          {t('connect.skip')}
        </Link>
      </p>
    </AuthFrame>
  )
}

/**
 * `/confirm-email/<token>`: the link from the mail that confirms an address. Works without being signed in (the link
 * is the proof); it is taken once, on purpose by the page, not by opening it (`POST /api/email/confirm`).
 */
export function ConfirmEmailPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [email, setEmail] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // A link works once: asked once per token, also when React runs the effect twice.
  const asked = useRef('')
  useEffect(() => {
    if (asked.current === token) return
    asked.current = token
    api<{ email: string }>('/api/email/confirm', { method: 'POST', body: { token } }).then(
      (answer) => setEmail(answer.email),
      (error) => setProblem(codeOf(error)),
    )
  }, [token])
  return (
    <AuthFrame title={t('confirmEmail.title')}>
      <Problem code={problem} />
      {!problem && !email && <p className="text-sm text-mist-400">{t('confirmEmail.busy')}</p>}
      {email && (
        <p role="status" className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500" data-testid="confirmed">
          {t('confirmEmail.done', { email })}
        </p>
      )}
      <Link to="/account?tab=notifications" className="nc-btn nc-btn-ghost mt-4 flex h-10 w-full items-center justify-center">
        {t('confirmEmail.toSettings')}
      </Link>
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
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const path = `/api/notify/unsubscribe/${encodeURIComponent(token)}`
  useEffect(() => {
    api<{ event: string; channel: string; on: boolean }>(path).then(setFound, (error) => setProblem(codeOf(error)))
  }, [path])
  const event = found ? t(found.event === 'daily' || found.event === 'weekly' ? `notify.${found.event}` : `notify.events.${found.event}`) : ''
  const channel = found ? t(`notify.channels.${found.channel}`, { defaultValue: found.channel }) : ''
  return (
    <AuthFrame title={t('unsubscribe.title')}>
      <Problem code={problem} />
      {found && !done && (
        <>
          <p className="text-sm text-mist-300">{found.on ? t('unsubscribe.ask', { event, channel }) : t('unsubscribe.already', { event, channel })}</p>
          {found.on && (
            <button
              type="button"
              disabled={busy}
              data-testid="unsubscribe"
              className="mt-4 h-10 w-full rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-600 disabled:opacity-50"
              onClick={() => {
                setBusy(true)
                api(path, { method: 'POST' }).then(
                  () => setDone(true),
                  (error) => setProblem(codeOf(error)),
                ).finally(() => setBusy(false))
              }}
            >
              {t('unsubscribe.button')}
            </button>
          )}
        </>
      )}
      {done && (
        <p role="status" className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">
          {t('unsubscribe.done')}
        </p>
      )}
      <Link to="/account?tab=notifications" className="nc-btn nc-btn-ghost mt-4 flex h-10 w-full items-center justify-center">
        {t('unsubscribe.toSettings')}
      </Link>
    </AuthFrame>
  )
}
