/**
 * The areas of the settings (plan "Einstellungen"), each with its own address (`/settings/<slug>`): "Mein Konto" for
 * every account (Profile, Security, Appearance, Notifications, Connections), "Server" for the operator only (General,
 * Connections, Sign-in, Mail, Storage and backups, Accounts, Log), and "Über nextasks" (`/settings/about`) for everyone, set apart
 * at the end. Titles and lines of the shared areas come from the ui kit (`areaText`). `/settings` alone is the list on
 * a phone and the profile beside it on a wider page. The addresses of before (`/account?tab=…`, `/about`,
 * `/settings?tab=…&sub=…`) lead to their area.
 *
 * Server › Connections (`server-connections`, plan E67, ui 1.2.1) holds "Andere nex-Apps" and "Schnittstellen", which
 * stood under General before: `/settings/general#nex-apps` and `#interfaces` lead there with their anchor.
 */
import type { GeneralPart, IconLike } from '../../vendor/nexui'
import type { Me } from '../../api/client'

type Role = Me['role']

export type AreaSlug = 'profile' | 'security' | 'appearance' | 'connections' | 'notifications' | 'general' | 'server-connections' | 'sign-in' | 'mail' | 'storage' | 'accounts' | 'log' | 'about'
export type AreaGroup = 'account' | 'server'

/** `own`: an area of nextasks alone, its title and line under `settings.areas.<slug>` of nextasks' words. */
export type Area = { slug: AreaSlug; group: AreaGroup; icon: IconLike; own?: boolean }

/** In the order of the navigation (plan "Einstellungen", "Reihenfolge Mein Konto" and "Reihenfolge Server"). */
export const AREAS: Area[] = [
  { slug: 'profile', group: 'account', icon: 'UserRound' },
  { slug: 'security', group: 'account', icon: 'ShieldCheck' },
  { slug: 'appearance', group: 'account', icon: 'Palette' },
  { slug: 'notifications', group: 'account', icon: 'Bell' },
  { slug: 'connections', group: 'account', icon: 'Plug' },
  { slug: 'general', group: 'server', icon: 'SlidersHorizontal' },
  { slug: 'server-connections', group: 'server', icon: 'Plug' },
  { slug: 'sign-in', group: 'server', icon: 'KeyRound' },
  { slug: 'mail', group: 'server', icon: 'Mail' },
  { slug: 'storage', group: 'server', icon: 'HardDrive' },
  { slug: 'accounts', group: 'server', icon: 'Users' },
  { slug: 'log', group: 'server', icon: 'ScrollText' },
]

export const GROUPS: AreaGroup[] = ['account', 'server']

/** "About nextasks": an area of every account, below the groups (its `group` only says who may open it). */
export const ABOUT_AREA: Area = { slug: 'about', group: 'account', icon: 'Info' }

/** The area of an address, the groups' and "About nextasks". */
export function findArea(slug: AreaSlug): Area | undefined {
  return slug === ABOUT_AREA.slug ? ABOUT_AREA : AREAS.find((area) => area.slug === slug)
}

/** The areas an account may open: the operator all, a member those of its own account (as the tab "Server" before). */
export function areasFor(role: Role | undefined): Area[] {
  return role === 'operator' ? AREAS : AREAS.filter((area) => area.group === 'account')
}

export function areaPath(slug: AreaSlug): string {
  return `/settings/${slug}`
}

/** The parts of the tab "Server" before, and where they stand now: the iPhone app and the API are switches of the card
 * "Schnittstellen", under Server › Connections since E67. */
const FORMER_PARTS: Record<string, AreaSlug> = { accounts: 'accounts', signin: 'sign-in', app: 'server-connections', api: 'server-connections', files: 'general', backups: 'storage', languages: 'general', log: 'log' }

/** The cards that left Server › General for Server › Connections (E67), by their anchor. */
const MOVED_FROM_GENERAL = new Set(['#nex-apps', '#interfaces'])

/** The tabs of "My account" before (`/account?tab=`). */
const FORMER_ACCOUNT: Record<string, AreaSlug> = { profile: 'profile', security: 'security', connections: 'connections', notifications: 'notifications' }

/** `search` without the parameters that named the tab before. */
function rest(search: string, ...drop: string[]): string {
  const params = new URLSearchParams(search)
  for (const name of drop) params.delete(name)
  const left = params.toString()
  return left ? `?${left}` : ''
}

/**
 * Where an address of the settings leads: the area itself, or the address to go to instead (an address of before, an
 * area the account may not open, which goes to the profile). The answer of a provider after linking (`?linked=`,
 * `?error=`) comes to `/settings` and belongs to Security, where the providers are.
 */
export function resolveArea(asked: string | undefined, role: Role | undefined, search: string, hash = ''): { area: AreaSlug } | { redirect: string } {
  const allowed = areasFor(role)
  const may = (slug: AreaSlug) => slug === ABOUT_AREA.slug || allowed.some((area) => area.slug === slug)
  // E67: a link to a card that moved (the cards' "Einrichten" of before, a partner's link, saved links) lands at its new
  // place, the anchor kept; a member goes to the profile as for every server area.
  if (asked === 'general' && MOVED_FROM_GENERAL.has(hash) && may('server-connections')) {
    return { redirect: areaPath('server-connections') + search + hash }
  }
  if (asked === undefined) {
    const params = new URLSearchParams(search)
    if (params.has('linked') || params.has('error')) return { redirect: areaPath('security') + search }
    const tab = params.get('tab')
    if (tab === 'looks') return { redirect: areaPath('appearance') }
    if (tab === 'server') {
      const part = FORMER_PARTS[params.get('sub') ?? ''] ?? 'accounts'
      return { redirect: may(part) ? areaPath(part) : '/settings' }
    }
    if (tab === 'general') return { redirect: areaPath('appearance') }
    return { area: 'profile' }
  }
  if (may(asked as AreaSlug) && findArea(asked as AreaSlug)) return { area: asked as AreaSlug }
  return { redirect: '/settings' }
}

/** `/account?tab=…` (links in mails, the provider's way back after linking), as the settings have it now. */
export function formerAccountPath(search: string): string {
  const params = new URLSearchParams(search)
  const tab = FORMER_ACCOUNT[params.get('tab') ?? ''] ?? (params.has('linked') || params.has('error') ? 'security' : 'profile')
  return areaPath(tab) + rest(search, 'tab')
}

/** The cards of Server › General in their order (`SettingsAreas.tsx` `GeneralArea`), for the line under its title (ui
 * 1.1.3, U-3): nextasks has no card for Web Push; "Andere nex-Apps" and "Schnittstellen" stand under Server ›
 * Connections (E67). */
export const GENERAL_PARTS: readonly GeneralPart[] = ['limits', 'features', 'languages']
