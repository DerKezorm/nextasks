/**
 * Settings (plan "Einstellungen") in the frame of the ui kit: `SettingsLayout` with `SettingsNav` (the account at the
 * top, "Mein Konto", "Server" for the operator, "Über nextasks" set apart at the end) and one `SettingsPage` per area:
 * its title, one line, then only cards. Each area has its own address (`/settings/<slug>`, `settings/areas.ts`).
 * `/settings` alone is the list on a phone and the profile beside the navigation on a wider page. An area someone may
 * not open, or an address of before, leads on with the address replaced, so the navigation always marks where one is.
 */
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'

import { Avatar } from '../components/Avatar'
import { useAuth } from '../state/auth'
import { areaText, languageOf, NEXUI_TEXTS, NexuiLanguage, SettingsLayout, SettingsNav, SettingsPage as AreaPage, type SettingsGroup } from '../vendor/nexui'
import { ABOUT_AREA, areaPath, areasFor, findArea, formerAccountPath, GENERAL_PARTS, GROUPS, resolveArea, type Area } from './settings/areas'
import { AreaContent } from './settings/SettingsAreas'

const APP = 'nextasks'

export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const { area: asked } = useParams()
  const { search } = useLocation()
  if (!me) return null
  const where = resolveArea(asked, me.role, search)
  if ('redirect' in where) return <Navigate to={where.redirect} replace />
  const area = findArea(where.area)
  if (!area) return null
  const things = t('settings.things')
  const words = (info: Area) =>
    info.own
      ? { title: t(`settings.areas.${info.slug}.title`), text: t(`settings.areas.${info.slug}.text`) }
      : (areaText(NEXUI_TEXTS[languageOf(i18n.language)], info.slug, { app: APP, things }) ?? { title: info.slug, text: '' })
  const groups: SettingsGroup[] = GROUPS.map((group) => ({
    id: group,
    areas: areasFor(me.role)
      .filter((entry) => entry.group === group)
      .map((entry) => ({ slug: entry.slug, icon: entry.icon, href: areaPath(entry.slug), title: entry.own ? words(entry).title : undefined })),
  }))
  const shown = me.display_name || me.name
  const own = area.own ? words(area) : null
  return (
    <main className="nt-scroll @container min-w-0 flex-1 overflow-y-auto">
        <NexuiLanguage language={i18n.language}>
          <SettingsLayout
            list={asked === undefined}
            back="/settings"
            link={Link}
            nav={
              <SettingsNav
                app={APP}
                things={things}
                thingsDative={t('settings.thingsDative')}
                groups={groups}
                about={{ href: areaPath(ABOUT_AREA.slug), slug: ABOUT_AREA.slug }}
                current={area.slug}
                account={{ name: shown, role: t(me.role === 'operator' ? 'account.roleOperator' : 'account.roleMember'), picture: <Avatar person={me} className="h-10 w-10 text-base" /> }}
                link={Link}
              />
            }
          >
            <AreaPage slug={area.slug} app={APP} things={things} thingsDative={t('settings.thingsDative')} title={own?.title} subtitle={own?.text} parts={area.slug === 'general' ? GENERAL_PARTS : undefined}>
              <AreaContent key={area.slug} area={area.slug} />
            </AreaPage>
          </SettingsLayout>
        </NexuiLanguage>
    </main>
  )
}

/** The addresses of before: `/account?tab=…` (also in mails and on the way back from a provider) and `/about`. */
export function FormerAccountAddress() {
  const { search } = useLocation()
  return <Navigate to={formerAccountPath(search)} replace />
}

export function FormerAboutAddress() {
  return <Navigate to={areaPath('about')} replace />
}
