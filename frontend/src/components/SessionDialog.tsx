/**
 * The session ended while the page was open (it ran out, the account was signed out everywhere). The page stays as it
 * is underneath, so nothing written is lost: sign in again right here, and the page goes on; what waited is sent by a
 * sync engine that starts over (`state/auth.tsx`, `session`). The dialog shows the parts of the shared account module for each step
 * the server names (`sessionExpiredParts(next)`, konten 0.3.5): the password and the providers, then the code or the
 * passkey. Below them the way out to the sign-in page, for somebody else or an account that is blocked now.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi, type Methods } from '../api/client'
import { passkeysSupported, signInWithPasskey } from '../lib/passkeys'
import { AuthField, Problem, troubleOf, waysIn, type Trouble } from '../pages/AuthPages'
import { useAuth } from '../state/auth'
import { sessionExpiredParts } from '../vendor/nexkonten/konten'
import { Dialog, TextLink } from '../vendor/nexui'
import { AccountButton } from './AccountButton'
import { ProviderButtons } from './ProviderButtons'

/** The steps this dialog shows itself; every other `next` lets the page go on (setting a factor up is the page's). */
type Step = 'sign_in' | 'second_factor' | 'passkey'

export function SessionDialog() {
  const { t } = useTranslation()
  const { interrupted, me, resume, leave } = useAuth()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<Step>('sign_in')
  const [problem, setProblem] = useState<Trouble>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (interrupted) void waysIn().then(setMethods)
  }, [interrupted])

  if (!interrupted) return null

  const goOn = async () => {
    setPassword('')
    setCode('')
    setStep('sign_in')
    setProblem(null)
    resume(await authApi.me())
  }

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      const found = troubleOf(error)
      setProblem(found)
      if (found.code === 'second_factor_expired' || found.code === 'sign_in_expired') setStep('sign_in')
    } finally {
      setBusy(false)
    }
  }

  const submit = () =>
    attempt(async () => {
      if (step === 'second_factor') {
        await authApi.code(code.trim())
        return goOn()
      }
      const answer = await authApi.login(me?.name || me?.email || '', password)
      if ('second_factor' in answer) {
        setPassword('')
        // `code: false`: the passkey is the only second step (the module's `next` = `passkey`).
        setStep(answer.code === false ? 'passkey' : 'second_factor')
        return
      }
      await goOn()
    })

  const withPasskey = () =>
    attempt(async () => {
      await signInWithPasskey()
      await goOn()
    })

  // `password` and its button only where the account has a password and signing in with one is on.
  const withPassword = (methods?.password ?? true) && me?.sign_in !== 'oidc'
  const parts = sessionExpiredParts(step).filter((part) => withPassword || step !== 'sign_in' || (part !== 'password' && part !== 'signInAgain'))
  const here = window.location.pathname + window.location.search
  return (
    <Dialog title={t('account.sessionExpired')} onClose={() => undefined} closeLabel={t('common.close')} testId="session-expired">
      <div className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Problem problem={problem} />
          {parts.map((part) => {
            switch (part) {
              case 'sessionExpiredHint':
                return (
                  <p key={part} className="m-0 text-sm">
                    {t('account.sessionExpiredHint')}
                  </p>
                )
              case 'password':
                return <AuthField key={part} label={t('account.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus />
              case 'code':
                return <AuthField key={part} label={t('account.code')} value={code} onChange={setCode} autoComplete="one-time-code" autoFocus hint={t('account.codeHint')} />
              case 'signInAgain':
                return <AccountButton key={part} name="account.signInAgain" type="submit" busy={busy} wide />
              case 'passkeySignIn':
                return passkeysSupported() ? <AccountButton key={part} name="account.passkeySignIn" disabled={busy} wide onClick={() => void withPasskey()} /> : null
              default:
                return null
            }
          })}
        </form>
        {parts.includes('or') && <ProviderButtons providers={methods?.providers ?? []} next={here} withOr={withPassword} />}
        <div className="text-center">
          <TextLink onClick={leave} testId="session-leave">
            {t('auth.backToLogin')}
          </TextLink>
        </div>
      </div>
    </Dialog>
  )
}
