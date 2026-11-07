/**
 * Settings, laid out like nexlore's and nexcanvas': whoever knows one finds their way in the other. General, Look,
 * and for the operator Server with a second row for its parts (the iPhone app and invitations among them). The tab is
 * in the address (`?tab=server&sub=backups`), so a link can point at one; a tab someone may not see falls back to
 * General. The own account is `AccountPage.tsx`; spaces and lists are made in the sidebar, which of them it shows is
 * chosen under General ("Spaces"), as which collections and own filters it shows ("Sidebar").
 */
import { Download, Eye, EyeOff, Files, FunnelPlus, Globe, History, Info, KeyRound, Layers, PanelLeft, Palette, Pencil, Plug, ShieldCheck, Smartphone, Users } from 'lucide-react'
import { createElement, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { authApi } from '../api/client'
import { changeLanguage, languageOptions, templateFile, type LanguageOption } from '../i18n'
import { Badge } from '../components/Badge'
import { useShell } from '../components/Shell'
import { setFilterHidden, setSpaceHidden, setTileHidden } from '../lib/actions'
import { applyMode, storedMode, type Mode } from '../lib/theme'
import { useAuth } from '../state/auth'
import { TILE_LOOK } from '../lib/tileLook'
import { useEngine, useFiltersOffered, useView } from '../state/sync'
import { TILE_IDS, TILES } from '../sync/tiles'
import { AccountsCard, ApiTokensCard, AppCard, BackupsCard, FilesCard, LanguagesCard, LogCard, MailCard, ProxyHint, useServerSettings } from './settings/ServerCards'
import { SignInPart } from './settings/SignInCards'
import { Card, saveAsFile, SubHead, TabRow, Toggle, type Tab } from './settings/ui'

type Top = 'general' | 'looks' | 'server'
type Part = 'accounts' | 'signin' | 'app' | 'api' | 'files' | 'backups' | 'languages' | 'log'
const TOPS: Top[] = ['general', 'looks', 'server']
const PARTS: Part[] = ['accounts', 'signin', 'app', 'api', 'files', 'backups', 'languages', 'log']
const TOP_ICON = { general: Globe, looks: Eye, server: ShieldCheck }
const PART_ICON = { accounts: Users, signin: KeyRound, app: Smartphone, api: Plug, files: Files, backups: History, languages: Globe, log: Info }

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const operator = me?.role === 'operator'
  const filtersOffered = useFiltersOffered()
  const asked = params.get('tab') as Top | null
  const top: Top = asked && TOPS.includes(asked) && (asked !== 'server' || operator) ? asked : 'general'
  const askedPart = params.get('sub') as Part | null
  const part: Part = askedPart && PARTS.includes(askedPart) ? askedPart : 'accounts'
  const go = (next: Top, sub?: Part) => setParams(next === 'general' ? {} : sub ? { tab: next, sub } : { tab: next }, { replace: true })

  const tops: Tab<Top>[] = TOPS.filter((value) => value !== 'server' || operator).map((value) => ({ value, label: t(`settings.tabs.${value}`), icon: TOP_ICON[value] }))
  const parts: Tab<Part>[] = PARTS.map((value) => ({ value, label: t(`settings.parts.${value}`), icon: PART_ICON[value] }))

  return (
    <main className="nc-scroll min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="text-2xl font-bold tracking-tight text-mist-100">{t('settings.title')}</h1>
        <TabRow tabs={tops} active={top} onChange={(value) => go(value)} label={t('settings.title')} />
        {top === 'server' && <TabRow under tabs={parts} active={part} onChange={(value) => go('server', value)} label={t('settings.tabs.server')} />}
        <div className="space-y-6 pt-1">
          {top === 'general' && <LanguageCard />}
          {top === 'general' && <SpacesCard />}
          {top === 'general' && filtersOffered && <SidebarCard />}
          {top === 'looks' && <Looks />}
          {top === 'server' && <ProxyHint />}
          {top === 'server' && <ServerPart part={part} />}
        </div>
      </div>
    </main>
  )
}

function LanguageCard() {
  const { t, i18n } = useTranslation()
  const { me, setMe } = useAuth()
  const operator = me?.role === 'operator'
  const [options, setOptions] = useState<LanguageOption[]>([])
  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setOptions(list))
    return () => {
      alive = false
    }
  }, [])
  return (
    <Card icon={Globe} title={t('settings.language.title')} text={operator ? t('settings.language.text') : t('settings.language.textMember')}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
        <label htmlFor="language" className="font-medium text-mist-100">
          {t('settings.language.choose')}
        </label>
        <select
          id="language"
          value={i18n.language}
          onChange={(e) => {
            const code = e.target.value
            void changeLanguage(code)
            void authApi.language(code).then(setMe, () => undefined)
          }}
          className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-mist-100"
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
              {option.added ? ` (${t('settings.language.added')})` : ''}
            </option>
          ))}
        </select>
        {operator && (
          <button
            type="button"
            onClick={() => saveAsFile('nextasks-language-template.json', templateFile())}
            className="ml-auto inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800"
            title={t('settings.language.templateHint')}
          >
            <Download className="h-4 w-4" strokeWidth={1.8} /> {t('settings.language.template')}
          </button>
        )}
      </div>
      {operator && <p className="text-xs text-mist-500">{t('settings.language.templateHint')}</p>}
    </Card>
  )
}

/** Which spaces the sidebar, the collections and the search show: one's own choice, on all devices (`space_pref`). */
function SpacesCard() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  return (
    <Card icon={Layers} title={t('space.prefsTitle')} text={t('space.prefsText')} id="spaces">
      {view.spaces.length === 0 && <p className="text-sm text-mist-500">{t('space.prefsNone')}</p>}
      {view.spaces.length > 0 && <p className="text-right text-xs font-medium text-mist-500">{t('space.prefsShown')}</p>}
      {view.spaces.map((space) => (
        <Toggle key={space.id} label={space.name} checked={!view.isHidden(space.id)} onChange={(shown) => setSpaceHidden(engine, space.id, !shown)} />
      ))}
    </Card>
  )
}

/** One entry of the sidebar overview: its sign, its name, what else it offers, and the eye to show or hide it. */
function EyeRow({ sign, label, name, hidden, onHidden, testId, children }: { sign: ReactNode; label: string; name?: ReactNode; hidden: boolean; onHidden: (hidden: boolean) => void; testId: string; children?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm" data-testid={testId}>
      {sign}
      <span className={'min-w-0 flex-1 truncate font-medium ' + (hidden ? 'text-mist-500' : 'text-mist-100')}>{name ?? label}</span>
      {children}
      <button
        type="button"
        aria-pressed={!hidden}
        aria-label={t(hidden ? 'sidebarPrefs.show' : 'sidebarPrefs.hide', { name: label })}
        title={t(hidden ? 'sidebarPrefs.show' : 'sidebarPrefs.hide', { name: label })}
        onClick={() => onHidden(!hidden)}
        className={'rounded-lg p-1.5 hover:bg-ink-800 ' + (hidden ? 'text-mist-500 hover:text-mist-100' : 'text-accent-400')}
        data-testid={`${testId}-eye`}
      >
        {hidden ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  )
}

/**
 * What the sidebar shows: the six collections and the own filters, each with an eye (`tile_pref`, `hidden` of the filter).
 * A filter one hid stays here, to change or to show again.
 */
function SidebarCard() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  return (
    <Card icon={PanelLeft} title={t('sidebarPrefs.title')} text={t('sidebarPrefs.text')} id="sidebar">
      <SubHead title={t('tiles.label')} />
      {TILES.map((tile) => (
        <EyeRow
          key={tile}
          testId={`pref-tile-${tile}`}
          sign={createElement(TILE_LOOK[tile].icon, { className: 'h-[18px] w-[18px] shrink-0 text-accent-400', strokeWidth: 2, 'aria-hidden': true })}
          label={t(`tiles.${tile}`)}
          hidden={view.isTileHidden(TILE_IDS[tile])}
          onHidden={(hidden) => setTileHidden(engine, tile, hidden)}
        />
      ))}
      <SubHead title={t('filter.section')} />
      {view.filters.length === 0 && <p className="text-sm text-mist-500">{t('sidebarPrefs.noFilters')}</p>}
      {view.filters.map((filter) => (
        <EyeRow
          key={filter.id}
          testId={`pref-filter-${filter.name}`}
          sign={<Badge color={filter.color} icon={filter.icon} size="sm" />}
          label={filter.name}
          name={
            <Link to={`/filters/${filter.id}`} className="hover:underline">
              {filter.name}
            </Link>
          }
          hidden={filter.hidden}
          onHidden={(hidden) => setFilterHidden(engine, filter.id, hidden)}
        >
          <button type="button" onClick={() => shell.editFilter(filter.id)} className="rounded-lg p-1.5 text-mist-500 hover:bg-ink-800 hover:text-mist-100" aria-label={t('filter.editNamed', { name: filter.name })} title={t('filter.editNamed', { name: filter.name })} data-testid={`pref-filter-${filter.name}-edit`}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        </EyeRow>
      ))}
      <button type="button" onClick={() => shell.newFilter()} className="inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800" data-testid="pref-new-filter">
        <FunnelPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('filter.new')}
      </button>
    </Card>
  )
}

/** Light or dark, kept in this browser, as the switch in the header. */
function Looks() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>(storedMode())
  return (
    <Card icon={Palette} title={t('settings.looks.title')} text={t('settings.looks.text')}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('theme.group')}>
        {(['dark', 'light', 'system'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => {
              applyMode(value)
              setMode(value)
            }}
            className={'rounded-full border px-4 py-2 text-sm font-medium ' + (mode === value ? 'border-accent-500/60 bg-accent-500/15 text-accent-400' : 'border-ink-700 bg-ink-900 text-mist-500 hover:text-mist-100')}
          >
            {t(`theme.${value}`)}
          </button>
        ))}
      </div>
    </Card>
  )
}

/** One part of the server, for the operator. */
function ServerPart({ part }: { part: Part }) {
  const server = useServerSettings()
  switch (part) {
    case 'accounts':
      return (
        <>
          <AccountsCard />
          <MailCard server={server} />
        </>
      )
    case 'signin':
      return <SignInPart server={server} />
    case 'app':
      return <AppCard server={server} />
    case 'api':
      return <ApiTokensCard server={server} />
    case 'files':
      return <FilesCard server={server} />
    case 'backups':
      return <BackupsCard server={server} />
    case 'languages':
      return <LanguagesCard />
    case 'log':
      return <LogCard />
  }
}
