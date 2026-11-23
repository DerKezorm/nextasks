/**
 * The areas of the settings, as nexnotes' (`pages/settings/areas.ts` there), each with its own address
 * (`/settings/<slug>`): "My account" for every account, "Server" for the operator only, and "About nextasks"
 * (`/settings/about`) for everyone at the end of the navigation, outside the groups. `/settings` is the profile. What
 * both apps have stands in the same area as in nexnotes; nextasks' own parts (notifications, the iPhone app, the
 * spaces and the sidebar) in the area their subject belongs to. The addresses of before (`/account?tab=…`, `/about`,
 * `/settings?tab=…&sub=…`) lead to their area.
 */
import { Bell, HardDrive, Info, KeyRound, Mail, Palette, Plug, ScrollText, ShieldCheck, SlidersHorizontal, UserRound, Users, type LucideIcon } from 'lucide-react'

import type { Me } from '../../api/client'

type Role = Me['role']

export type AreaSlug = 'profile' | 'security' | 'appearance' | 'connections' | 'notifications' | 'general' | 'sign-in' | 'mail' | 'storage' | 'accounts' | 'log' | 'about'
export type AreaGroup = 'account' | 'server'

export type Area = { slug: AreaSlug; group: AreaGroup; icon: LucideIcon; key: string }

/** In the order of the navigation; `key` names the texts `settings.areas.<key>.title` and `.text`. */
export const AREAS: Area[] = [
  { slug: 'profile', group: 'account', icon: UserRound, key: 'profile' },
  { slug: 'security', group: 'account', icon: ShieldCheck, key: 'security' },
  { slug: 'appearance', group: 'account', icon: Palette, key: 'appearance' },
  { slug: 'connections', group: 'account', icon: Plug, key: 'connections' },
  { slug: 'notifications', group: 'account', icon: Bell, key: 'notifications' },
  { slug: 'general', group: 'server', icon: SlidersHorizontal, key: 'general' },
  { slug: 'sign-in', group: 'server', icon: KeyRound, key: 'signIn' },
  { slug: 'mail', group: 'server', icon: Mail, key: 'mail' },
  { slug: 'storage', group: 'server', icon: HardDrive, key: 'storage' },
  { slug: 'accounts', group: 'server', icon: Users, key: 'accounts' },
  { slug: 'log', group: 'server', icon: ScrollText, key: 'log' },
]

export const GROUPS: AreaGroup[] = ['account', 'server']

/** "About nextasks": an area of every account, below the groups (its `group` only says who may open it). */
export const ABOUT_AREA: Area = { slug: 'about', group: 'account', icon: Info, key: 'about' }

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

/** The parts of the tab "Server" before, and where they stand now. */
const FORMER_PARTS: Record<string, AreaSlug> = { accounts: 'accounts', signin: 'sign-in', app: 'general', api: 'general', files: 'general', backups: 'storage', languages: 'general', log: 'log' }

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
export function resolveArea(asked: string | undefined, role: Role | undefined, search: string): { area: AreaSlug } | { redirect: string } {
  const allowed = areasFor(role)
  const may = (slug: AreaSlug) => slug === ABOUT_AREA.slug || allowed.some((area) => area.slug === slug)
  if (asked === undefined) {
    const params = new URLSearchParams(search)
    if (params.has('linked') || params.has('error')) return { redirect: areaPath('security') + search }
    const tab = params.get('tab')
    if (tab === 'looks') return { redirect: areaPath('appearance') }
    if (tab === 'server') {
      const part = FORMER_PARTS[params.get('sub') ?? ''] ?? 'accounts'
      return { redirect: may(part) ? areaPath(part) : '/settings' }
    }
    if (tab === 'general') return { redirect: '/settings' }
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
