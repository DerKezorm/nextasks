/**
 * Who is in a space, and invitations into it (only with the network). Managers invite by link (and, with the
 * operator's mail server, by mail: `POST /api/spaces/{id}/invites`), change roles and remove; everybody may leave. The
 * last manager can neither go nor step down while others are there.
 */
import { Copy, Link2, LogOut, Mail, UserMinus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { api, ApiError } from '../api/client'
import { copyText } from '../lib/copy'
import { errorText } from '../lib/errors'
import { moment } from '../lib/time'
import { useAuth } from '../state/auth'
import { useEngine, useView } from '../state/sync'
import { AppError } from '../sync/transport'
import { Dialog } from './Dialog'
import { personName, PersonAvatar } from './People'

type Invite = { id: string; expires_at: string; created_by: number }

function codeOf(error: unknown): string {
  return error instanceof AppError || error instanceof ApiError ? error.code : 'internal_error'
}

export function MembersDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const navigate = useNavigate()
  const space = view.space(spaceId)
  const manager = space?.role === 'manager'
  const [invites, setInvites] = useState<Invite[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const { me } = useAuth()
  const [email, setEmail] = useState('')
  const [mailed, setMailed] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!manager) return
    engine.call<Invite[]>('GET', `/spaces/${spaceId}/invites`).then(setInvites, () => undefined)
  }, [engine, manager, spaceId])
  useEffect(load, [load])

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(errorText(codeOf(error)))
    } finally {
      setBusy(false)
    }
  }

  if (!space) return null
  const members = [...view.membersOf(spaceId)].sort((a, b) => (a.role !== b.role ? (a.role === 'manager' ? -1 : 1) : personName(view.people.get(a.account_id), t).localeCompare(personName(view.people.get(b.account_id), t))))

  return (
    <Dialog title={t('members.titleOf', { space: space.name })} onClose={onClose} medium>
      <div className="space-y-5">
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700" data-testid="members">
          {members.map((m) => {
            const person = view.people.get(m.account_id)
            const me = m.account_id === view.me
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <PersonAvatar id={m.account_id} person={person} className="h-8 w-8 text-sm" />
                <span className="min-w-0 flex-1 truncate text-mist-100">
                  {personName(person, t)}
                  {me && <span className="ml-1.5 text-xs text-mist-500">{t('members.you')}</span>}
                </span>
                {manager && !me ? (
                  <select
                    aria-label={t('members.roleOf', { name: personName(person, t) })}
                    className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-mist-100"
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void run(() => engine.call('PUT', `/spaces/${spaceId}/members/${m.account_id}`, { role: e.target.value }))}
                  >
                    <option value="manager">{t('members.manager')}</option>
                    <option value="member">{t('members.member')}</option>
                  </select>
                ) : (
                  <span className="text-xs text-mist-500">{t(m.role === 'manager' ? 'members.manager' : 'members.member')}</span>
                )}
                {manager && !me && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t('members.removeName', { name: personName(person, t) })}
                    className="rounded-full p-1.5 text-mist-500 hover:bg-bad-500/10 hover:text-bad-500"
                    onClick={() => void run(() => engine.call('DELETE', `/spaces/${spaceId}/members/${m.account_id}`))}
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-mist-500">{t('members.rolesHint')}</p>

        {manager && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-mist-100">{t('members.inviteTitle')}</h3>
            <p className="text-xs text-mist-500">{t('members.inviteText')}</p>
            <button
              type="button"
              disabled={busy}
              className="nc-btn nc-btn-accent"
              onClick={() =>
                void run(async () => {
                  const made = await engine.call<{ id: string; link: string; expires_at: string }>('POST', `/spaces/${spaceId}/invites`)
                  setLink(made.link)
                  setCopied(false)
                  load()
                })
              }
            >
              <Link2 className="h-4 w-4" /> {t('members.makeLink')}
            </button>
            {link && (
              <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 p-2">
                <input readOnly value={link} className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs text-mist-200" aria-label={t('members.link')} onFocus={(e) => e.target.select()} />
                <button type="button" className="nc-btn nc-btn-ghost" onClick={() => void copyText(link).then((ok) => setCopied(ok))}>
                  <Copy className="h-4 w-4" /> {copied ? t('members.copied') : t('members.copy')}
                </button>
              </div>
            )}
            {me?.mail && (
              <form
                className="flex flex-wrap items-end gap-2 pt-2"
                data-testid="invite-mail"
                onSubmit={(event) => {
                  event.preventDefault()
                  const to = email.trim()
                  if (!to) return
                  setMailed(null)
                  void run(async () => {
                    const made = await api<{ link: string }>(`/api/spaces/${spaceId}/invites`, { method: 'POST', body: { email: to, language: i18n.language } })
                    setLink(made.link)
                    setCopied(false)
                    setEmail('')
                    setMailed(to)
                    load()
                  })
                }}
              >
                <label className="min-w-56 flex-1 text-sm">
                  <span className="text-xs font-medium text-mist-400">{t('members.mailTitle')}</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label={t('members.mailAddress')} className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 text-sm text-mist-100" />
                </label>
                <button type="submit" disabled={busy || !email.trim()} className="nc-btn nc-btn-ghost">
                  <Mail className="h-4 w-4" /> {t('members.mailSend')}
                </button>
                <p className="w-full text-xs text-mist-500">{t('members.mailText')}</p>
                {mailed && (
                  <p role="status" className="w-full text-xs text-ok-500">
                    {t('members.mailSent', { email: mailed })}
                  </p>
                )}
              </form>
            )}
            {invites.length > 0 && (
              <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700 text-xs" data-testid="invites">
                {invites.map((invite) => (
                  <li key={invite.id} className="flex items-center gap-3 px-3 py-2 text-mist-300">
                    <span className="flex-1">{t('members.inviteOpen', { name: personName(view.people.get(invite.created_by), t), until: moment(invite.expires_at, i18n.language) })}</span>
                    <button type="button" disabled={busy} className="text-bad-500 hover:underline" onClick={() => void run(async () => (await engine.call('DELETE', `/spaces/${spaceId}/invites/${invite.id}`), load()))}>
                      {t('members.withdraw')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {problem && (
          <p role="alert" className="rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
            {problem}
          </p>
        )}

        <div className="flex justify-between gap-2 border-t border-ink-700/70 pt-4">
          {leaving ? (
            <button
              type="button"
              disabled={busy}
              className="nc-btn bg-bad-500 text-on-bad"
              onClick={() =>
                void run(async () => {
                  await engine.call('DELETE', `/spaces/${spaceId}/members/${view.me}`)
                  onClose()
                  navigate('/today')
                })
              }
            >
              <LogOut className="h-4 w-4" /> {t('members.leaveSure')}
            </button>
          ) : (
            <button type="button" className="nc-btn nc-btn-ghost text-bad-500" onClick={() => setLeaving(true)}>
              <LogOut className="h-4 w-4" /> {t('members.leave')}
            </button>
          )}
          <button type="button" className="nc-btn nc-btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
