/**
 * My account › Appearance (plan "Einstellungen", Darstellung): first "Aussehen" of the shared account module (light, dark
 * or as the device says, for the account on every device, konten 1.1.0 `AppearanceCard`), then nextasks' own cards from
 * the ui kit: what the sidebar shows (the collections and the own filters, `tile_pref` and `hidden` of a filter; only
 * where the server knows filters), which spaces it shows (`space_pref`, on all devices), and the keyboard shortcuts.
 */
import { FunnelPlus, Keyboard, Layers, PanelLeft, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { authApi } from '../../api/client'
import { Mark } from '../../components/Mark'
import { useShell } from '../../components/Shell'
import { setFilterHidden, setSpaceHidden, setTileHidden } from '../../lib/actions'
import { useSomedayShown } from '../../lib/someday'
import { applyMode, type Mode } from '../../lib/theme'
import { useAuth } from '../../state/auth'
import { useEngine, useFiltersOffered, useView } from '../../state/sync'
import { TILE_IDS, TILES } from '../../sync/tiles'
import { AppearanceCard } from '../../vendor/nexkonten/AccountCards'
import { Box, Button, Buttons, Card, CheckboxRow, Row, Rows } from '../../vendor/nexui'

export function AppearanceArea() {
  const filtersOffered = useFiltersOffered()
  const { me, setMe } = useAuth()
  return (
    <>
      <AppearanceCard
        theme={me?.theme}
        onChange={(theme) => {
          applyMode(theme as Mode)
          void authApi.theme(theme).then(setMe, () => undefined)
        }}
      />
      {filtersOffered && <SidebarCard />}
      <SpacesCard />
      <KeysCard />
    </>
  )
}

/** Which spaces the sidebar shows: kept at the account, on all devices. */
function SpacesCard() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  return (
    <Card id="spaces" icon={Layers} title={t('space.prefsTitle')} subtitle={t('space.prefsText')}>
      {view.spaces.length === 0 && <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('space.prefsNone')}</p>}
      {view.spaces.map((space) => (
        <CheckboxRow
          key={space.id}
          label={space.name}
          checked={!view.isHidden(space.id)}
          onChange={(shown) => setSpaceHidden(engine, space.id, !shown)}
          testId={`pref-space-${space.name}`}
        />
      ))}
    </Card>
  )
}

/**
 * What the sidebar shows: the collections and the own filters, each a box to tick (`tile_pref`, `hidden` of the filter).
 * A filter one hid stays here, to change or to show again.
 */
function SidebarCard() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [someday, setSomeday] = useSomedayShown()
  return (
    <Card id="sidebar" icon={PanelLeft} title={t('sidebarPrefs.title')} subtitle={t('sidebarPrefs.text')}>
      <Box title={t('tiles.label')} testId="pref-tiles">
        {TILES.map((tile) => (
          <div key={tile} className="flex flex-col gap-2">
            <CheckboxRow
              testId={`pref-tile-${tile}`}
              label={t(`tiles.${tile}`)}
              checked={!view.isTileHidden(TILE_IDS[tile])}
              onChange={(shown) => setTileHidden(engine, tile, !shown)}
            />
            {/* "Someday" is the web's own: shown or hidden on this device only. */}
            {tile === 'all' && (
              <CheckboxRow
                testId="pref-tile-someday"
                label={t('someday.title')}
                hint={t('someday.device')}
                checked={someday}
                onChange={(shown) => setSomeday(shown)}
              />
            )}
          </div>
        ))}
      </Box>
      <Box
        title={t('filter.section')}
        hint={view.filters.length === 0 ? t('sidebarPrefs.noFilters') : undefined}
        testId="pref-filters"
        actions={
          <Button kind="secondary" icon={FunnelPlus} onClick={() => shell.newFilter()} testId="pref-new-filter">
            {t('filter.new')}
          </Button>
        }
      >
        {view.filters.map((filter) => (
          <CheckboxRow
            key={filter.id}
            testId={`pref-filter-${filter.name}`}
            label={filter.name}
            checked={!filter.hidden}
            onChange={(shown) => setFilterHidden(engine, filter.id, !shown)}
          />
        ))}
        {view.filters.length > 0 && (
          <Rows label={t('filter.section')}>
            {view.filters.map((filter) => (
              <Row
                key={filter.id}
                lead={<Mark color={filter.color} icon={filter.icon} size={16} />}
                name={
                  <Link to={`/filters/${filter.id}`} className="hover:underline">
                    {filter.name}
                  </Link>
                }
                action={
                  <Button kind="secondary" size="sm" icon={Pencil} onClick={() => shell.editFilter(filter.id)} aria-label={t('filter.editNamed', { name: filter.name })} testId={`pref-filter-${filter.name}-edit`}>
                    {t('filter.edit')}
                  </Button>
                }
              />
            ))}
          </Rows>
        )}
      </Box>
    </Card>
  )
}

/** The list of keys, which `?` opens anywhere in the app too; here for whoever does not know that key. */
function KeysCard() {
  const { t } = useTranslation()
  const shell = useShell()
  return (
    <Card id="keys" icon={Keyboard} title={t('keys.title')} subtitle={t('keys.text')}>
      <Buttons>
        <Button kind="secondary" icon={Keyboard} onClick={() => shell.openKeys()} testId="keys-open">
          {t('keys.show')}
        </Button>
      </Buttons>
    </Card>
  )
}
