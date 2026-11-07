/**
 * "Notifications" in the own account: one table of what comes which way. Its rows are the reports (with their time)
 * and the events, its columns the channels as the server lists them (mail, browser, iPhone/iPad today; a new channel
 * on the server is a new column here by itself), each head with its symbol and state. A channel that cannot be used
 * now (no mail server, no confirmed address, no browser, no paired device) is greyed; what was chosen for it stays.
 * On a narrow screen, or with more than four channels, the table becomes a card per row with a labelled switch per
 * channel, so nothing scrolls sideways.
 *
 * Below it the parts of the channels that need more than a head: the mail address with its confirmation, and this
 * browser (on or off) with the list of browsers that take notifications.
 */
import { AtSign, Bell, Globe, Mail, Smartphone, Trash2, Zap, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { api, ApiError } from '../api/client'
import { errorText } from '../lib/errors'
import { usePwa } from '../lib/pwa'
import { moment } from '../lib/time'
import { disablePush, enablePush, ownEndpointMark, pushState, type PushState } from '../lib/webpush'
import { useAuth } from '../state/auth'
import { useEngine, useSyncState } from '../state/sync'
import { AppError } from '../sync/transport'
import { Section } from './Section'

export type Browser = { id: number; browser: string; system: string; since: string | null; last_ok_at: string | null; mark: string }

export type NotifyChannel = {
  kind: string
  name: string
  icon: string
  available: boolean
  ready: boolean
  state: string
  summary: string
  hint: string
  link: string
  link_label: string
  defaults?: string[]
  last_ok_at: string | null
  last_error: string
  last_error_at: string | null
  address?: string
  confirmed?: boolean
  pending?: string
  pending_until?: string | null
  suggestion?: string
  can_send?: boolean
  browsers?: Browser[]
}

export type NotifyState = {
  channels: NotifyChannel[]
  reports: string[]
  events: string[]
  routes: Record<string, string[]>
  schedules: Record<string, { time: string; weekday: number }>
  timezone: string
  sent?: boolean
}

type Run = (work: () => Promise<NotifyState | undefined>, success?: (next: NotifyState) => string | null) => Promise<void>

/** The symbols the server may name for a channel; any other gets the bell. */
const ICONS: Record<string, LucideIcon> = { mail: Mail, globe: Globe, smartphone: Smartphone, bell: Bell }
/** More channels than this do not fit as columns. */
const MOST_COLUMNS = 4
const NARROW = '(max-width: 767px)'

function codeOf(error: unknown): string {
  return error instanceof ApiError || error instanceof AppError ? error.code : 'internal_error'
}

/** Monday … Sunday in the page's language (0 is Monday, as the server counts). */
function weekdays(language: string): string[] {
  const monday = new Date(Date.UTC(2026, 10, 2, 12))
  return Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(new Date(monday.getTime() + day * 86_400_000)))
}

/** True below the width of a tablet: the table becomes cards. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW).matches : false))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(NARROW)
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  return narrow
}

const FIELD = 'h-9 rounded-lg border border-ink-700 bg-ink-850 px-2.5 text-sm text-mist-100 disabled:opacity-50'

/** This browser's web push: its state, whether the server offers it, and switching it. Shared by the head of the
 * column "Browser" and the section below, so the button sits where one looks first. */
function useBrowserPush(channel: NotifyChannel | undefined, reload: () => Promise<void>) {
  const engine = useEngine()
  useSyncState()
  const [here, setHere] = useState<PushState | null>(null)
  const [mine, setMine] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const count = channel?.browsers?.length ?? 0
  useEffect(() => {
    void pushState().then(setHere, () => setHere('unsupported'))
    void ownEndpointMark().then(setMine, () => setMine(null))
  }, [count])
  const offered = engine.me?.features.includes('webpush') ?? false
  const toggle = (on: boolean) => {
    setProblem(null)
    void (on ? enablePush(engine) : disablePush(engine)).then(
      (next) => {
        setHere(next)
        void reload()
      },
      (error) => setProblem(errorText(codeOf(error))),
    )
  }
  const browsers = channel?.browsers ?? []
  // Signed up here, but the server no longer lists it (removed from another browser): off, a click signs it up again.
  const shownHere: PushState | null = here === 'on' && mine && !browsers.some((entry) => entry.mark === mine) ? 'off' : here
  return { here: shownHere, mine, problem, offered, toggle, browsers }
}

type BrowserPushState = ReturnType<typeof useBrowserPush>

export function NotificationsPart() {
  const { t } = useTranslation()
  const [state, setState] = useState<NotifyState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const narrow = useNarrow()

  const load = useCallback(() => api<NotifyState>('/api/notify').then(setState, (error) => setProblem(errorText(codeOf(error)))), [])
  const push = useBrowserPush(state?.channels.find((channel) => channel.kind === 'webpush'), load)
  useEffect(() => {
    void load()
  }, [load])

  const run: Run = async (work, success) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      const next = await work()
      if (next) {
        setState(next)
        if (success) setDone(success(next))
      }
    } catch (error) {
      setProblem(errorText(codeOf(error)))
    } finally {
      setBusy(false)
    }
  }

  if (!state) return problem ? <p className="text-sm text-bad-500">{problem}</p> : null

  const turn = (event: string, channel: string, on: boolean) => run(() => api<NotifyState>('/api/notify/routes', { method: 'PUT', body: { event, channel, on } }), () => t('notify.saved'))
  const schedule = (report: string, time: string, weekday?: number) =>
    run(() => api<NotifyState>(`/api/notify/schedules/${report}`, { method: 'PUT', body: { time, weekday } }), () => t('notify.saved'))
  const mail = state.channels.find((channel) => channel.kind === 'mail')
  const browser = state.channels.find((channel) => channel.kind === 'webpush')
  const cards = narrow || state.channels.length > MOST_COLUMNS
  const rows: Rows = { state, busy, turn, schedule, push }

  return (
    <div className="space-y-6" data-testid="notifications">
      <p className="text-sm text-mist-400">{t('notify.lead')}</p>
      <div aria-live="polite">
        {problem && (
          <p role="alert" className="rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
            {problem}
          </p>
        )}
        {done && (
          <p role="status" className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">
            {done}
          </p>
        )}
      </div>

      <Section icon={Zap} title={t('notify.tableTitle')}>
        {cards ? <RouteCards {...rows} /> : <RouteTable {...rows} />}
        <p className="mt-3 text-xs text-mist-500">
          {t('notify.reportsText')} {t('notify.zone', { zone: state.timezone })}
        </p>
      </Section>

      {mail?.available && <MailAddress channel={mail} busy={busy} run={run} />}
      {browser && <BrowserPush channel={browser} busy={busy} run={run} push={push} />}
    </div>
  )
}

type Rows = {
  state: NotifyState
  busy: boolean
  turn: (event: string, channel: string, on: boolean) => Promise<void>
  schedule: (report: string, time: string, weekday?: number) => Promise<void>
  push: BrowserPushState
}

/** The head of a channel: symbol, name, its state in a few words, why it cannot be used, where to set it up. */
function ChannelHead({ channel, compact = false, push }: { channel: NotifyChannel; compact?: boolean; push?: BrowserPushState }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const Icon = ICONS[channel.icon] ?? Bell
  const tone = channel.state === 'ready' ? 'text-ok-500' : channel.state === 'setup' ? 'text-warn-500' : 'text-mist-500'
  return (
    <div className={'flex min-w-0 flex-col gap-0.5 ' + (compact ? '' : 'items-center text-center')} data-testid={`channel-${channel.kind}`}>
      <span className="flex items-center gap-1.5 text-sm font-semibold text-mist-100">
        <Icon className="h-4 w-4 shrink-0 text-accent-400" strokeWidth={1.8} aria-hidden /> {channel.name}
      </span>
      <span className={(compact ? 'max-w-full' : 'max-w-36') + ' truncate text-xs font-medium ' + tone} title={channel.summary}>
        {channel.summary}
      </span>
      {channel.kind === 'webpush' && push?.offered && (push.here === 'off' || push.here === 'on') ? (
        <button
          type="button"
          className={'nc-btn mt-1 px-2.5 py-1 text-xs ' + (push.here === 'on' ? 'nc-btn-ghost' : 'nc-btn-accent')}
          onClick={() => push.toggle(push.here !== 'on')}
          data-testid="push-toggle-head"
        >
          {push.here === 'on' ? t('push.offHere') : t('push.onHere')}
        </button>
      ) : channel.kind === 'webpush' && push?.offered && (push.here === 'denied' || push.here === 'unsupported') ? (
        <span className="text-[11px] leading-snug font-normal text-warn-500" data-testid="push-head-blocked">
          {push.here === 'denied' ? t('push.deniedShort') : t('push.unsupportedShort')}
        </span>
      ) : (
        channel.state !== 'ready' && channel.hint && <span className="text-[11px] leading-snug font-normal text-mist-500">{channel.hint}</span>
      )}
      {channel.link && (
        <Link to={channel.link} className="text-[11px] font-medium text-accent-400 hover:underline">
          {channel.link_label || channel.link}
        </Link>
      )}
      {channel.kind === 'mail' && channel.state === 'unavailable' && me?.role === 'operator' && (
        <Link to="/settings?tab=server&sub=accounts" className="text-[11px] font-medium text-accent-400 hover:underline">
          {t('notify.toMailServer')}
        </Link>
      )}
    </div>
  )
}

function rowName(t: (key: string) => string, state: NotifyState, event: string): string {
  return state.reports.includes(event) ? t(`notify.${event}`) : t(`notify.events.${event}`)
}

/** What a row is: name and a line about it, for a report also when it comes. */
function RowLabel({ event, state, busy, schedule }: { event: string } & Pick<Rows, 'state' | 'busy' | 'schedule'>) {
  const { t } = useTranslation()
  const report = state.reports.includes(event)
  const about = report ? t(`notify.${event}Text`) : event === 'changed' ? t('notify.changedHint', { label: t('list.notifyOn') }) : ''
  return (
    <span className="flex min-w-0 flex-col gap-2 text-left lg:flex-row lg:items-center lg:gap-6">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-mist-100">{rowName(t, state, event)}</span>
        {about && <span className="block max-w-xl text-xs font-normal text-mist-500">{about}</span>}
      </span>
      {report && <span className="shrink-0"><ScheduleFields report={event} value={state.schedules[event]} busy={busy} onChange={schedule} /></span>}
    </span>
  )
}

function RouteTable({ state, busy, turn, schedule, push }: Rows) {
  const { t } = useTranslation()
  const groups: [string, string[]][] = [
    [t('notify.reportsTitle'), state.reports],
    [t('notify.eventsTitle'), state.events],
  ]
  return (
    <table className="w-full border-collapse text-left" data-testid="routes">
      <thead>
        <tr className="border-b border-ink-700">
          <th scope="col" className="pb-3 align-top text-xs font-medium text-mist-500">
            {t('notify.what')}
          </th>
          {state.channels.map((channel) => (
            <th key={channel.kind} scope="col" data-channel={channel.kind} className={'w-40 px-2 pb-3 align-top font-normal ' + (channel.ready ? '' : 'opacity-70')}>
              <ChannelHead channel={channel} push={push} />
            </th>
          ))}
        </tr>
      </thead>
      {groups.map(([title, events]) => (
        <tbody key={title}>
          <tr>
            <th scope="colgroup" colSpan={state.channels.length + 1} className="nt-sec pt-5 pb-2 text-left">
              {title}
            </th>
          </tr>
          {events.map((event) => (
            <tr key={event} className="border-t border-ink-700" data-testid={`row-${event}`}>
              <th scope="row" className="py-3 pr-3 align-middle font-normal">
                <RowLabel event={event} state={state} busy={busy} schedule={schedule} />
              </th>
              {state.channels.map((channel) => (
                <td key={channel.kind} className="px-2 py-3 text-center align-middle">
                  <RouteBox event={event} channel={channel} state={state} busy={busy} turn={turn} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  )
}

function RouteCards({ state, busy, turn, schedule }: Rows) {
  const { t } = useTranslation()
  const groups: [string, string[]][] = [
    [t('notify.reportsTitle'), state.reports],
    [t('notify.eventsTitle'), state.events],
  ]
  return (
    <div className="space-y-4" data-testid="route-cards">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label={t('notify.channelsTitle')}>
        {state.channels.map((channel) => (
          <li key={channel.kind} className={'rounded-xl border border-ink-700 px-3 py-2 ' + (channel.ready ? '' : 'opacity-70')}>
            <ChannelHead channel={channel} compact />
          </li>
        ))}
      </ul>
      {groups.map(([title, events]) => (
        <div key={title} className="space-y-2">
          <h3 className="nt-sec">{title}</h3>
          {events.map((event) => (
            <div key={event} className="rounded-xl border border-ink-700 p-3" data-testid={`row-${event}`}>
              <RowLabel event={event} state={state} busy={busy} schedule={schedule} />
              <div className="mt-2 divide-y divide-ink-700">
                {state.channels.map((channel) => {
                  const Icon = ICONS[channel.icon] ?? Bell
                  return (
                    <label key={channel.kind} className={'flex min-h-11 items-center gap-2 py-1.5 text-sm text-mist-200 ' + (channel.ready ? '' : 'opacity-60')}>
                      <Icon className="h-4 w-4 shrink-0 text-accent-400" strokeWidth={1.8} aria-hidden />
                      <span className="flex-1">{channel.name}</span>
                      <RouteBox event={event} channel={channel} state={state} busy={busy} turn={turn} asSwitch />
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** One choice: this report or event on this channel. Greyed while the channel cannot be used; the choice stays. */
function RouteBox({ event, channel, state, busy, turn, asSwitch = false }: { event: string; channel: NotifyChannel; asSwitch?: boolean } & Pick<Rows, 'state' | 'busy' | 'turn'>) {
  const { t } = useTranslation()
  const on = state.routes[event]?.includes(channel.kind) ?? false
  return (
    <input
      type="checkbox"
      role={asSwitch ? 'switch' : undefined}
      className={asSwitch ? 'nt-switch' : 'h-5 w-5 accent-accent-500 disabled:opacity-40'}
      checked={on}
      disabled={busy || !channel.ready}
      title={channel.ready ? undefined : channel.hint || channel.summary}
      aria-label={t('notify.on', { event: rowName(t, state, event), channel: channel.name })}
      data-testid={`route-${event}-${channel.kind}`}
      onChange={(e) => void turn(event, channel.kind, e.target.checked)}
    />
  )
}

function ScheduleFields({ report, value, busy, onChange }: { report: string; value: { time: string; weekday: number } | undefined; busy: boolean; onChange: (report: string, time: string, weekday?: number) => void }) {
  const { t, i18n } = useTranslation()
  const [time, setTime] = useState(value?.time ?? '07:00')
  useEffect(() => setTime(value?.time ?? '07:00'), [value?.time])
  const names = weekdays(i18n.language)
  return (
    <span className="flex flex-wrap items-center gap-2">
      {report === 'weekly' && (
        <select aria-label={t('notify.weekday')} className={FIELD} value={value?.weekday ?? 6} disabled={busy} onChange={(e) => onChange(report, time, Number(e.target.value))} data-testid={`weekday-${report}`}>
          {names.map((name, day) => (
            <option key={day} value={day}>
              {name}
            </option>
          ))}
        </select>
      )}
      <input
        type="time"
        step={900}
        aria-label={t('notify.at')}
        className={FIELD}
        value={time}
        disabled={busy}
        data-testid={`time-${report}`}
        onChange={(e) => setTime(e.target.value)}
        onBlur={() => time && time !== value?.time && onChange(report, time, report === 'weekly' ? value?.weekday : undefined)}
      />
    </span>
  )
}

function MailAddress({ channel, busy, run }: { channel: NotifyChannel; busy: boolean; run: Run }) {
  const { t, i18n } = useTranslation()
  const [address, setAddress] = useState('')
  const send = (value: string) =>
    run(
      () => api<NotifyState>('/api/me/email', { method: 'PUT', body: { address: value.trim() } }),
      (next) => (next.sent ? t('notify.mail.sent', { address: value.trim() }) : null),
    ).then(() => setAddress(''))
  const canSend = channel.can_send !== false
  return (
    <Section icon={AtSign} title={t('notify.mail.title')} id="mail">
      <p className="mb-3 text-sm text-mist-400">{t('notify.mail.text')}</p>
      {channel.confirmed && channel.address && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="mail-address">
          <span className="font-medium text-mist-100">{channel.address}</span>
          <span className="rounded-full bg-accent-500/15 px-2 py-0.5 text-xs text-accent-400">{t('notify.mail.confirmed')}</span>
          <button type="button" className="nc-btn nc-btn-ghost text-xs" disabled={busy} onClick={() => void run(() => api<NotifyState>('/api/me/email', { method: 'DELETE' }), () => t('notify.mail.removed'))}>
            {t('notify.mail.remove')}
          </button>
        </p>
      )}
      {channel.pending && (
        <div className="mb-3 rounded-xl border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-mist-200" data-testid="mail-pending">
          <p>{t('notify.mail.pending', { address: channel.pending, until: channel.pending_until ? moment(channel.pending_until, i18n.language) : '' })}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="nc-btn nc-btn-ghost text-xs" disabled={busy || !canSend} onClick={() => void run(() => api<NotifyState>('/api/me/email/resend', { method: 'POST' }), () => t('notify.mail.sent', { address: channel.pending }))}>
              {t('notify.mail.resend')}
            </button>
            <button type="button" className="nc-btn nc-btn-ghost text-xs" disabled={busy} onClick={() => void run(() => api<NotifyState>('/api/me/email/pending', { method: 'DELETE' }))}>
              {t('notify.mail.cancel')}
            </button>
          </div>
        </div>
      )}
      {!canSend && <p className="mb-3 text-sm text-warn-500">{t('notify.mail.noPublic')}</p>}
      {channel.suggestion && !channel.pending && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-mist-300" data-testid="mail-suggestion">
          {t('notify.mail.suggestion', { address: channel.suggestion })}
          <button type="button" className="nc-btn nc-btn-ghost text-xs" disabled={busy || !canSend} onClick={() => void send(channel.suggestion ?? '')}>
            {t('notify.mail.useSuggestion')}
          </button>
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim()) void send(address)
        }}
      >
        <label className="min-w-60 flex-1 text-sm">
          <span className="text-xs font-medium text-mist-400">{t('notify.mail.address')}</span>
          <input type="email" autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={channel.address || 'name@example.com'} className={FIELD + ' mt-1 w-full'} data-testid="mail-input" />
        </label>
        <button type="submit" className="nc-btn nc-btn-accent" disabled={busy || !canSend || !address.trim()}>
          {t('notify.mail.send')}
        </button>
      </form>
      <LastDelivery channel={channel} />
    </Section>
  )
}

/** When the channel delivered last, and its last failure. */
function LastDelivery({ channel }: { channel: NotifyChannel }) {
  const { t, i18n } = useTranslation()
  if (!channel.last_ok_at && !channel.last_error) return null
  return (
    <p className="mt-3 text-xs text-mist-500" data-testid={`${channel.kind}-status`}>
      {channel.last_ok_at && t('notify.lastOk', { when: moment(channel.last_ok_at, i18n.language) })}
      {channel.last_ok_at && channel.last_error && ' · '}
      {channel.last_error && channel.last_error_at && <span className="text-bad-500">{t('notify.lastError', { error: errorText(channel.last_error), when: moment(channel.last_error_at, i18n.language) })}</span>}
    </p>
  )
}

/** This browser on or off (web push), and every browser that takes notifications, with "Remove". */
function BrowserPush({ channel, busy, run, push }: { channel: NotifyChannel; busy: boolean; run: Run; push: BrowserPushState }) {
  const { t, i18n } = useTranslation()
  const { ios, standalone } = usePwa()
  const { here: shownHere, mine, problem, offered, toggle, browsers } = push
  const name = (entry: Browser) => (entry.browser && entry.system ? t('push.browserOn', { browser: entry.browser, system: entry.system }) : entry.browser || entry.system || t('push.unknown'))
  return (
    <Section icon={Globe} title={t('push.title')} id="browser">
      <p className="mb-3 text-sm text-mist-400">{t('push.text')}</p>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 px-3 py-2.5" data-testid="push-here">
        <span className="flex-1 text-sm text-mist-100">
          {t('push.thisBrowser')}{' '}
          <span className={shownHere === 'on' ? 'font-semibold text-ok-500' : 'font-semibold text-mist-400'}>{shownHere === 'on' ? t('push.stateOn') : t('push.stateOff')}</span>
        </span>
        {offered && (shownHere === 'off' || shownHere === 'on') && (
          <button type="button" className={'nc-btn ' + (shownHere === 'on' ? 'nc-btn-ghost' : 'nc-btn-accent')} disabled={busy} onClick={() => toggle(shownHere !== 'on')} data-testid="push-toggle">
            {shownHere === 'on' ? t('push.off') : t('push.on')}
          </button>
        )}
      </div>
      {shownHere === 'unsupported' && <p className="mt-2 text-sm text-mist-500">{t('push.unsupported')}</p>}
      {shownHere === 'denied' && <p className="mt-2 text-sm text-warn-500">{t('push.denied')}</p>}
      {problem && <p className="mt-2 text-xs text-bad-500">{problem}</p>}
      <p className={'mt-2 text-xs ' + (ios && !standalone ? 'text-warn-500' : 'text-mist-500')} data-testid="push-ios">
        {t('push.iosHint')}
      </p>

      <h3 className="mt-5 mb-2 text-sm font-semibold text-mist-100">{t('push.list')}</h3>
      {browsers.length === 0 && <p className="text-sm text-mist-500">{t('push.none')}</p>}
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700 empty:hidden" data-testid="browsers">
        {browsers.map((entry) => {
          const current = !!mine && mine === entry.mark
          return (
            <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <Globe className="h-4 w-4 shrink-0 text-mist-500" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-mist-100">
                  {name(entry)}
                  {current && <span className="ml-2 rounded-full bg-accent-500/15 px-2 py-0.5 text-xs text-accent-400">{t('push.current')}</span>}
                </span>
                {entry.since && <span className="text-xs text-mist-500">{t('push.since', { when: moment(entry.since, i18n.language) })}</span>}
              </span>
              <button
                type="button"
                className="nc-btn nc-btn-ghost text-bad-500"
                disabled={busy}
                aria-label={t('push.removeName', { name: name(entry) })}
                onClick={() => (current ? toggle(false) : void run(() => api<NotifyState>(`/api/notify/browsers/${entry.id}`, { method: 'DELETE' })))}
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('push.remove')}
              </button>
            </li>
          )
        })}
      </ul>
      <LastDelivery channel={channel} />
    </Section>
  )
}
