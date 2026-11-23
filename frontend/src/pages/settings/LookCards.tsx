/**
 * Settings › Appearance, as nexnotes': light, dark or as the system (on this device only), then nextasks' own views:
 * what the sidebar shows (the collections and the own filters, `tile_pref` and `hidden` of a filter; only where the
 * server knows filters), which spaces it shows (`space_pref`, on all devices), and the keyboard shortcuts.
 */
import { Eye, EyeOff, FunnelPlus, Keyboard, Layers, PanelLeft, Palette, Pencil } from 'lucide-react'
import { createElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Mark } from '../../components/Mark'
import { useShell } from '../../components/Shell'
import { ThemeSwitcher } from '../../components/ThemeSwitcher'
import { setFilterHidden, setSpaceHidden, setTileHidden } from '../../lib/actions'
import { TILE_LOOK } from '../../lib/tileLook'
import { useEngine, useFiltersOffered, useView } from '../../state/sync'
import { TILE_IDS, TILES } from '../../sync/tiles'
import { Card, SubHead, Toggle } from './ui'

export function LookCards() {
  const filtersOffered = useFiltersOffered()
  return (
    <div className="space-y-6">
      <LooksCard />
      {filtersOffered && <SidebarCard />}
      <SpacesCard />
      <KeysCard />
    </div>
  )
}

/** Light, dark or as the system: kept in this browser. */
function LooksCard() {
  const { t } = useTranslation()
  return (
    <Card id="looks" icon={Palette} title={t('me.looks.title')}>
      <div className="text-sm">
        <span className="font-medium">{t('me.looks.appearance')}</span> <span className="text-xs text-mist-500">{t('me.looks.appearanceHint')}</span>
        <div className="mt-1.5">
          <ThemeSwitcher withWords />
        </div>
      </div>
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
    <div className="flex items-center gap-3 rounded-[12px] border border-ink-700 bg-ink-900 px-4 py-2.5 text-sm" data-testid={testId}>
      {sign}
      <span className={'min-w-0 flex-1 truncate font-medium ' + (hidden ? 'text-mist-500' : 'text-mist-100')}>{name ?? label}</span>
      {children}
      <button
        type="button"
        aria-pressed={!hidden}
        aria-label={t(hidden ? 'sidebarPrefs.show' : 'sidebarPrefs.hide', { name: label })}
        title={t(hidden ? 'sidebarPrefs.show' : 'sidebarPrefs.hide', { name: label })}
        onClick={() => onHidden(!hidden)}
        className={'rounded-[9px] p-1.5 hover:bg-ink-800 ' + (hidden ? 'text-mist-500 hover:text-mist-100' : 'text-accent-400')}
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
          sign={<Mark color={filter.color} icon={filter.icon} size={18} />}
          label={filter.name}
          name={
            <Link to={`/filters/${filter.id}`} className="hover:underline">
              {filter.name}
            </Link>
          }
          hidden={filter.hidden}
          onHidden={(hidden) => setFilterHidden(engine, filter.id, hidden)}
        >
          <button type="button" onClick={() => shell.editFilter(filter.id)} className="nt-icon-btn" aria-label={t('filter.editNamed', { name: filter.name })} title={t('filter.editNamed', { name: filter.name })} data-testid={`pref-filter-${filter.name}-edit`}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        </EyeRow>
      ))}
      <button type="button" onClick={() => shell.newFilter()} className="nt-btn nt-btn-ghost" data-testid="pref-new-filter">
        <FunnelPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('filter.new')}
      </button>
    </Card>
  )
}

/** The list of keys, which `?` opens anywhere in the app too; here for whoever does not know that key. */
function KeysCard() {
  const { t } = useTranslation()
  const shell = useShell()
  return (
    <Card id="keys" icon={Keyboard} title={t('keys.title')} text={t('keys.text')}>
      <button type="button" className="nt-btn nt-btn-ghost" onClick={() => shell.openKeys()} data-testid="keys-open">
        <Keyboard className="h-4 w-4" strokeWidth={1.8} aria-hidden /> {t('keys.show')}
      </button>
    </Card>
  )
}
