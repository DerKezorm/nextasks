// The sidebar and the settings as nexnotes', against the fake server: "+ New task" and the search under the logo, the
// account with the way to the settings at the foot (chosen while they are open), no account menu, no light/dark or
// keys button there; the settings in areas under `/settings/<area>` with the groups "My account" and, for the
// operator only, "Server"; the addresses of before lead to their area; the width of the sidebar is dragged and kept.
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { forgetPrefs } from '../lib/devicePref'
import { smallWorld } from '../test/fakeServer'
import { button, choose, click, mount, press, settle, submit, type, unmount, where } from '../test/harness'

afterEach(async () => {
  await unmount()
  forgetPrefs()
})

const sidebar = (page: HTMLElement) => page.querySelector('aside[data-testid="sidebar"]') as HTMLElement

describe('the sidebar', () => {
  it('has "+ New task" and the search under the logo, and the page head neither', async () => {
    const { server, home } = smallWorld()
    const page = await mount(server, `/lists/${home}`)
    const places = sidebar(page).querySelector('[data-testid="sidebar-places"]')!
    expect(places.firstElementChild?.querySelector('[data-testid="new-reminder"]')?.textContent).toBe('New task')
    const search = places.querySelector('[data-testid="sidebar-search"]')!
    expect(search.getAttribute('href')).toBe('/search')
    expect(search.querySelector('[data-testid="search-key"]')?.textContent).toBe('Ctrl K')
    const head = page.querySelector('main header')!
    expect(head.querySelector('a[href="/search"]')).toBeNull()
    expect(head.querySelector('[data-testid="new-reminder"]')).toBeNull()
    // The button makes the task where the page's old button did: in the list shown.
    await click(sidebar(page).querySelector('[data-testid="new-reminder"]'))
    expect(where.path).toContain('reminder=new')
    expect(page.querySelector('[data-testid="detail"]')?.getAttribute('data-draft')).toBe('true')
  })

  it('ends with the account and the way to the settings, chosen while they are open, without menu, theme or keys', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/today')
    const foot = sidebar(page).querySelector('[data-testid="sidebar-account"]')!
    expect(foot.getAttribute('href')).toBe('/settings')
    // Only the name shows; the gear says settings, the word stays for screen readers and the tooltip.
    expect(foot.querySelector('span.truncate')?.textContent).toBe('Robin')
    expect(foot.textContent).not.toContain('Settings')
    expect(foot.getAttribute('aria-label')).toBe('Robin · Settings')
    expect(foot.getAttribute('title')).toBe('Robin · Settings')
    expect(foot.className).not.toContain('nt-chosen')
    expect(button(page, 'Account of Robin')).toBeUndefined()
    expect(sidebar(page).querySelector('[role="radiogroup"], [aria-label="Keyboard shortcuts"]')).toBeNull()
    await click(foot)
    expect(where.path).toBe('/settings')
    expect(sidebar(page).querySelector('[data-testid="sidebar-account"]')?.className).toContain('nt-chosen')
    await click(page.querySelector('[data-testid="settings-nav-appearance"]'))
    expect(where.path).toBe('/settings/appearance')
    expect(sidebar(page).querySelector('[data-testid="sidebar-account"]')?.className).toContain('nt-chosen')
  })

  it('is as wide as one sets it with the keys, kept for the account on this device, a double click back to 260', async () => {
    const { server, robin } = smallWorld()
    const page = await mount(server, '/today')
    const handle = page.querySelector('[data-testid="column-handle-sidebar"]')!
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
    expect([handle.getAttribute('aria-valuemin'), handle.getAttribute('aria-valuemax')]).toEqual(['200', '440'])
    await press(handle, 'ArrowRight')
    expect(sidebar(page).style.width).toBe('276px')
    expect(localStorage.getItem(`nextasks.column.sidebar.${robin}`)).toBe('276')
    await press(handle, 'End')
    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    await press(handle, 'Home')
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    await act(async () => void handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    await settle()
    expect(sidebar(page).style.width).toBe('260px')
    expect(localStorage.getItem(`nextasks.column.sidebar.${robin}`)).toBeNull()
  })
})

describe('the settings', () => {
  it('show the operator both groups and "About nextasks" apart at the end', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/settings')
    const nav = page.querySelector('[data-testid="settings-nav"]')!
    expect(nav.textContent).toContain('Robin')
    expect([...nav.querySelectorAll('p[id^="settings-group-"]')].map((head) => head.textContent)).toEqual(['My account', 'Server'])
    expect([...nav.querySelectorAll('ul a')].map((entry) => entry.textContent)).toEqual([
      'Profile',
      'Security',
      'Appearance',
      'Notifications',
      'Connections',
      'General',
      'Sign-in',
      'Mail',
      'Storage and backups',
      'Accounts',
      'Log',
    ])
    expect(nav.querySelector('[data-testid="settings-nav-about"]')?.textContent).toBe('About nextasks')
    expect(nav.querySelector('[data-testid="settings-nav-profile"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('show a member only "My account", and lead a server address to the profile', async () => {
    const { server, alex } = smallWorld()
    server.session = alex
    const page = await mount(server, '/settings/general')
    expect(where.path).toBe('/settings')
    const nav = page.querySelector('[data-testid="settings-nav"]')!
    expect([...nav.querySelectorAll('p[id^="settings-group-"]')].map((head) => head.textContent)).toEqual(['My account'])
    expect(nav.querySelector('[data-testid="settings-nav-general"]')).toBeNull()
    expect([...nav.querySelectorAll('[data-testid^="settings-nav-"]')].map((entry) => entry.getAttribute('data-testid')?.slice('settings-nav-'.length))).toEqual([
      'profile',
      'security',
      'appearance',
      'notifications',
      'connections',
      'about',
    ])
    for (const area of ['sign-in', 'mail', 'storage', 'accounts', 'log']) {
      await unmount()
      await mount(server, `/settings/${area}`)
      expect(where.path).toBe('/settings')
    }
  })

  it('lead the addresses of before to their area', async () => {
    const { server } = smallWorld()
    const cases: [string, string][] = [
      ['/account', '/settings/profile'],
      ['/account?tab=notifications', '/settings/notifications'],
      ['/account?tab=connections', '/settings/connections'],
      ['/account?linked=pocket', '/settings/security?linked=pocket'],
      ['/about', '/settings/about'],
      ['/settings?tab=looks', '/settings/appearance'],
      ['/settings?tab=general', '/settings/appearance'],
      ['/settings?tab=server&sub=backups', '/settings/storage'],
      ['/settings?tab=server&sub=app', '/settings/general'],
      ['/settings?tab=server&sub=api', '/settings/general'],
    ]
    for (const [before, now] of cases) {
      await mount(server, before)
      expect(where.path).toBe(now)
      await unmount()
    }
  })

  it('have the profile with name, role, the language for every device, and "Sign out" at its end', async () => {
    const { server, robin } = smallWorld()
    const page = await mount(server, '/settings/profile')
    const area = page.querySelector('[data-testid="settings-area-profile"]')!
    expect(area.querySelector('h1')?.textContent).toBe('Profile')
    expect(area.querySelector('#profile')?.textContent).toContain('Role: Operator')
    expect(area.querySelector('#profile')?.textContent).toContain('(on all your devices)')
    const language = area.querySelector('[data-testid="language-select"]') as HTMLSelectElement
    expect(language.options[0].textContent).toBe('As the browser')
    await choose(language, 'de')
    expect(server.accounts.get(robin)?.language).toBe('de')
    const cards = [...area.querySelectorAll('section[id]')].map((card) => card.id)
    expect(cards.at(-1)).toBe('sign-out')
    await click(area.querySelector('[data-testid="sign-out"]'))
    expect(server.session).toBeNull()
    expect(where.path).toMatch(/^\/login/)
  })

  it('say that the profile is saved in the green notice of the shared kit, as nexnotes now', async () => {
    // Display name, username and address save with one button (konten 0.3.7); the profile is the module's page, built
    // from the kit, whose success is its notice in the tone "ok" (nexnotes' profile since the module).
    const { server } = smallWorld()
    const page = await mount(server, '/settings/profile')
    const area = page.querySelector('[data-testid="settings-area-profile"]')!
    const name = area.querySelector('input[autocomplete="name"]')
    await type(name, 'Robin R.')
    await submit(name!.closest('form'))
    const saved = area.querySelector('[role="status"]') as HTMLElement
    expect(saved.textContent).toBe('Profile saved.')
    expect(saved.className).toContain('var(--nexui-ok)')
  })

  it('put light, dark and system under Appearance, with the keys there too', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/settings/appearance')
    // "Aussehen" first (konten 1.1.0 `AppearanceCard`), kept at the account on every device.
    const looks = page.querySelector('[data-card="appearance"]')!
    expect(page.querySelector('[data-card]')).toBe(looks)
    expect([...looks.querySelectorAll('[role="radio"]')].map((choice) => choice.textContent)).toEqual(['Light', 'Dark', 'As the system'])
    await click(button(looks, 'Light'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await settle()
    expect(server.requests.some((r) => r.method === 'PUT' && r.path === '/api/me/theme')).toBe(true)
    await click(button(looks, 'Dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
    await click(page.querySelector('[data-testid="keys-open"]'))
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Keyboard shortcuts')
  })

  it('draw every switch as a box in a row, never a sliding switch', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/settings/general')
    // Every switch a box to tick in a row with its label (`CheckboxRow`), none a sliding switch (ui 1.1.0, E11).
    const switches = [...page.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(switches.length).toBeGreaterThan(3)
    expect(switches.every((entry) => !!entry.id && page.querySelector(`label[for="${entry.id}"]`) !== null)).toBe(true)
    expect(page.querySelector('[role="switch"], .nt-switch')).toBeNull()
    // The cards in the plan's order: limits, features for all accounts, interfaces (the API, the iPhone app), languages.
    expect([...page.querySelectorAll('[data-card]')].map((card) => card.getAttribute('data-card'))).toEqual(['limits', 'features', 'interfaces', 'languages'])
    // The words as the plan and nexnotes write them (E39, E48): the same sentence on every server's features card.
    expect(page.querySelector('[data-card="features"]')?.textContent).toContain('What every account may use on this server.')
    expect([...page.querySelectorAll('[data-card="limits"] label')].map((label) => label.textContent)).toContain('Largest file per attachment (MB)')
  })
})

describe('the ways that must stay', () => {
  it('let an account that still has to set up its second factor sign out on the one page open to it', async () => {
    const { server, robin } = smallWorld()
    server.accounts.get(robin)!.setupRequired = true
    const page = await mount(server, '/today')
    expect(where.path).toBe('/settings/security')
    expect(page.querySelector('[data-card="sign-out"]')).not.toBeNull()
  })

  it('keep "New space" when every space is hidden, and only then in the head of the hidden ones', async () => {
    const { server, robin } = smallWorld()
    const mine = [...server.rows.values()].filter((r) => r.kind === 'space' && server.member(r.id, robin)).map((r) => r.id)
    server.addPref('space_pref', mine[0], robin, { hidden: true })
    let page = await mount(server, '/today')
    expect(page.querySelector('[data-testid="new-space-hidden"]')).toBeNull()
    await unmount()
    for (const id of mine.slice(1)) server.addPref('space_pref', id, robin, { hidden: true })
    page = await mount(server, '/today')
    expect(page.querySelector('[data-testid="new-space-hidden"]')?.getAttribute('aria-label')).toBe('New space')
  })
})
