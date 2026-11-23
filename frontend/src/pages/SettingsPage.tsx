/**
 * Settings in areas, as nexnotes': "My account" (Profile, Security, Appearance, Connections, Notifications) for every
 * account, "Server" (General, Sign-in, Mail, Storage and backups, Accounts, Log) for the operator, "About nextasks" for
 * everyone at the end. Each area has its own address (`/settings/<slug>`, `settings/areas.ts`), `/settings` is the
 * profile. An area someone may not open, or an address of before, leads on with the address replaced, so the
 * navigation always marks where one is. Which area holds what of before: `notes/einstellungen-zuordnung.md`.
 */
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useParams } from 'react-router-dom'

import { useAuth } from '../state/auth'
import { areaPath, findArea, formerAccountPath, resolveArea } from './settings/areas'
import { AreaContent } from './settings/SettingsAreas'
import { SettingsJump, SettingsNav } from './settings/SettingsNav'

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const { area: asked } = useParams()
  const { search } = useLocation()
  if (!me) return null
  const where = resolveArea(asked, me.role, search)
  if ('redirect' in where) return <Navigate to={where.redirect} replace />
  const area = findArea(where.area)
  if (!area) return null
  const title = t(`settings.areas.${area.key}.title`)
  return (
    <main className="nt-scroll @container min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-col gap-5 @min-[700px]:flex-row @min-[700px]:items-start @min-[700px]:gap-8">
          <SettingsNav me={me} current={area.slug} />
          <SettingsJump me={me} current={area.slug} />
          <div className="min-w-0 flex-1 space-y-5" data-testid={`settings-area-${area.slug}`}>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-mist-100">{title}</h1>
              <p className="mt-1 text-sm text-mist-400">{t(`settings.areas.${area.key}.text`)}</p>
            </div>
            <div className="space-y-6">
              <AreaContent key={area.slug} area={area.slug} />
            </div>
          </div>
        </div>
      </div>
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
