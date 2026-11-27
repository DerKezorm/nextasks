/**
 * "Notifications" in the own account: one table of what comes which way. Its rows are the reports (with their time)
 * and the events, its columns the channels as the server lists them (mail, browser, iPhone/iPad today; a new channel
 * on the server is a new column here by itself), each head with its symbol and state. A channel that cannot be used
 * now (no mail server, no confirmed address, no browser, no paired device) is greyed; what was chosen for it stays.
 * On a narrow screen, or with more than four channels, the table becomes a card per row with a labelled box per
 * channel, so nothing scrolls sideways.
 *
 * Below it the parts of the channels that need more than a head: the mail address (its state, changed in the profile),
 * and this browser (on or off) with the list of browsers that take notifications.
 */
import { Bell, Globe, Mail, Smartphone, Zap, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { api, ApiError } from '../api/client'
import { CONNECTIONS_HREF, DEVICES_BASE, deviceRequest } from '../lib/devices'
import { errorText } from '../lib/errors'
import { usePwa } from '../lib/pwa'
import { moment } from '../lib/time'
import { disablePush, enablePush, ownEndpointMark, pushState, type PushState } from '../lib/webpush'
import { useAuth } from '../state/auth'
import { useEngine, useSyncState } from '../state/sync'
import { AppError } from '../sync/transport'
import { DevicePushCard, useDevicesWay } from '../vendor/nexgeraete'
import { Card, Notice, NotifyWays } from '../vendor/nexui'
import { Done } from './Field'

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

const FIELD = 'nt-field h-9 w-auto px-2.5 disabled:opacity-50'

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
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<NotifyState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const narrow = useNarrow()
  const pwa = usePwa()

  const load = useCallback(() => api<NotifyState>('/api/notify').then(setState, (error) => setProblem(errorText(codeOf(error)))), [])
  const push = useBrowserPush(state?.channels.find((channel) => channel.kind === 'webpush'), load)
  const devicesWay = useDevicesWay(deviceRequest, { base: DEVICES_BASE, href: CONNECTIONS_HREF, language: i18n.language })
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

  const { ios, standalone } = pwa
  const name = (entry: Browser) => (entry.browser && entry.system ? t('push.browserOn', { browser: entry.browser, system: entry.system }) : entry.browser || entry.system || t('push.unknown'))
  return (
    <>
      <div aria-live="polite" className="empty:hidden" data-testid="notifications">
        {problem && <Notice tone="danger">{problem}</Notice>}
        <Done text={done} />
      </div>
      {/* "Auf welchem Weg" first, from the ui kit (plan "Einstellungen", Benachrichtigungen): the ways nextasks has. */}
      <NotifyWays
        subtitle={t('notify.lead')}
        mail={mail?.available ? { address: mail.confirmed && mail.address ? mail.address : t('notify.mail.none'), confirmed: !!(mail.confirmed && mail.address), href: '/settings/profile' } : undefined}
        // "This browser" always (E59, as nexnotes): blocked or unable, it says why and its button stays locked.
        browser={
          browser && push.offered
            ? {
                on: push.here === 'on',
                onTurnOn: () => push.toggle(true),
                onTurnOff: () => push.toggle(false),
                busy,
                disabled: push.here !== 'on' && push.here !== 'off',
                note: push.here === 'denied' ? t('push.denied') : push.here === 'unsupported' ? t('push.unsupported') : undefined,
              }
            : undefined
        }
        browsers={
          browser
            ? {
                items: push.browsers.map((entry) => ({
                  id: String(entry.id),
                  name: name(entry),
                  detail: entry.since ? t('push.since', { when: moment(entry.since, i18n.language) }) : undefined,
                  current: !!push.mine && push.mine === entry.mark,
                })),
                busy,
                onRemove: (id) => {
                  const entry = push.browsers.find((found) => String(found.id) === id)
                  if (entry && push.mine && push.mine === entry.mark) push.toggle(false)
                  else void run(() => api<NotifyState>(`/api/notify/browsers/${id}`, { method: 'DELETE' }))
                },
              }
            : undefined
        }
        devices={state.channels.some((channel) => channel.kind === 'app') ? (devicesWay ?? { href: CONNECTIONS_HREF }) : undefined}
      >
        {mail?.pending && <Notice tone="warn">{t('account.emailPending', { email: mail.pending })}</Notice>}
        {mail?.available && mail.can_send === false && <Notice tone="warn">{t('notify.mail.noPublic')}</Notice>}
        {browser && !push.offered && push.here === 'unsupported' && <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('push.unsupported')}</p>}
        {browser && !push.offered && push.here === 'denied' && <Notice tone="warn">{t('push.denied')}</Notice>}
        {push.problem && <Notice tone="danger">{push.problem}</Notice>}
        {browser && (
          <p className={'m-0 text-xs ' + (ios && !standalone ? 'text-[var(--nexui-warn)]' : 'text-[var(--nexui-text-muted)]')} data-testid="push-ios">
            {t('push.iosHint')}
          </p>
        )}
        {mail && <LastDelivery channel={mail} />}
        {browser && <LastDelivery channel={browser} />}
      </NotifyWays>

      {/* The device module's card (geraete 0.1.0): per device, which kinds of notification it gets. */}
      {state.channels.some((channel) => channel.kind === 'app') && (
        <DevicePushCard request={deviceRequest} base={DEVICES_BASE} app="nextasks" language={i18n.language} connectionsHref={CONNECTIONS_HREF} />
      )}

      {/* nextasks' own: what comes which way (E18). */}
      <Card id="routes" icon={Zap} title={t('notify.tableTitle')} subtitle={`${t('notify.reportsText')} ${t('notify.zone', { zone: state.timezone })}`}>
        {cards ? <RouteCards {...rows} /> : <RouteTable {...rows} />}
      </Card>
    </>
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
          className={'nt-btn mt-1 h-8 px-2.5 text-xs ' + (push.here === 'on' ? 'nt-btn-ghost' : 'nt-btn-accent')}
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
        <Link to="/settings/mail" className="text-[11px] font-medium text-accent-400 hover:underline">
          {t('notify.toMailServer')}
        </Link>
      )}
    </div>
  )
}

function rowName(t: (key: string) => string, state: NotifyState, event: string): string {
  if (event === 'comment' || event === 'mention') return t(`comments.notify.${event}`)
  return state.reports.includes(event) ? t(`notify.${event}`) : t(`notify.events.${event}`)
}

/** What a row is: name and a line about it, for a report also when it comes. */
function RowLabel({ event, state, busy, schedule }: { event: string } & Pick<Rows, 'state' | 'busy' | 'schedule'>) {
  const { t } = useTranslation()
  const report = state.reports.includes(event)
  const about = report ? t(`notify.${event}Text`) : event === 'changed' ? t('notify.changedHint', { label: t('list.notifyOn') }) : ''
  return (
    // Wraps instead of squeezing: the line about the row keeps at least 14rem, else the time fields go below it (the
    // weekly report's weekday and time took so much room that its text stood one word per line).
    <span className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 text-left">
      <span className="min-w-56 flex-1 basis-56">
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
                      <RouteBox event={event} channel={channel} state={state} busy={busy} turn={turn} />
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

/** One choice: this report or event on this channel, a box as every switch of the settings (as nexnotes'). Greyed
 * while the channel cannot be used; the choice stays. */
function RouteBox({ event, channel, state, busy, turn }: { event: string; channel: NotifyChannel } & Pick<Rows, 'state' | 'busy' | 'turn'>) {
  const { t } = useTranslation()
  const on = state.routes[event]?.includes(channel.kind) ?? false
  return (
    <input
      type="checkbox"
      className="h-5 w-5 shrink-0 accent-accent-500 disabled:opacity-40"
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

/** When the channel delivered last, and its last failure. */
function LastDelivery({ channel }: { channel: NotifyChannel }) {
  const { t, i18n } = useTranslation()
  if (!channel.last_ok_at && !channel.last_error) return null
  return (
    <p className="m-0 text-xs text-[var(--nexui-text-muted)]" data-testid={`${channel.kind}-status`}>
      {channel.last_ok_at && t('notify.lastOk', { when: moment(channel.last_ok_at, i18n.language) })}
      {channel.last_ok_at && channel.last_error && ' · '}
      {channel.last_error && channel.last_error_at && <span className="text-bad-500">{t('notify.lastError', { error: errorText(channel.last_error), when: moment(channel.last_error_at, i18n.language) })}</span>}
    </p>
  )
}
