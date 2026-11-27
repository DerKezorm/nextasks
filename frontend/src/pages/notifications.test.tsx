// "Notifications" in the own account, against the fake server: one table, a column per channel the server lists (mail,
// browser, iPhone/iPad) with its state; without a mail server mail is greyed with the reason, the address is confirmed
// by a link before mail can be turned on, the browsers and the app carry what they carried before, choices and times
// go to the server, a narrow screen gets cards with boxes, a link from a mail confirms or unsubscribes, and
// managers invite into a space by mail. The address itself is entered in the profile (the shared account module).
import { afterEach, describe, expect, it, vi } from 'vitest'

import { smallWorld } from '../test/fakeServer'
import { button, click, mount, submit, type, unmount } from '../test/harness'

afterEach(async () => {
  await unmount()
  vi.unstubAllGlobals()
})

const box = (page: HTMLElement, id: string) => page.querySelector(`[data-testid="${id}"]`) as HTMLInputElement

function withMail() {
  const world = smallWorld()
  world.server.settings.smtp_host = 'mail.example.test'
  world.server.settings.public_url = 'https://tasks.example.test'
  return world
}

describe('notifications', () => {
  it('show one table with a column per channel, mail greyed with the reason without a mail server', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/account?tab=notifications')
    const heads = [...page.querySelectorAll('[data-testid="routes"] thead th[data-channel]')]
    expect(heads.map((head) => head.getAttribute('data-channel'))).toEqual(['mail', 'webpush', 'app'])
    expect(heads.map((head) => head.querySelector('span')?.textContent?.trim())).toEqual(['Mail', 'Browser', 'iPhone/iPad'])
    expect(page.querySelector('[data-testid="channel-mail"]')?.textContent).toContain('No mail server')
    expect(page.querySelector('[data-testid="channel-mail"]')?.textContent).toContain('once the operator sets up a mail server')
    expect(page.querySelector('[data-testid="channel-app"]')?.textContent).toContain('No device')
    expect(page.querySelector('[data-testid="channel-app"] a')?.getAttribute('href')).toBe('/account?tab=connections')
    expect(box(page, 'route-daily-mail').disabled).toBe(true)
    expect(page.querySelector('[data-testid="mail-input"]')).toBeNull()
    expect(page.querySelectorAll('[data-testid="routes"] tbody tr[data-testid^="row-"]')).toHaveLength(6)
    // "iPhone and iPad" in "Auf welchem Weg" leads to Connections (plan "Einstellungen", E4).
    expect(page.querySelector('[data-testid="notify-devices"]')?.getAttribute('href')).toBe('/settings/connections')
  })

  it('carry on the browsers and the app what came there before, greyed until there is one, and switch it per channel', async () => {
    const { server, robin } = smallWorld()
    const page = await mount(server, '/settings/notifications')
    for (const event of ['assigned', 'due', 'changed']) {
      expect(box(page, `route-${event}-webpush`).checked).toBe(true)
      expect(box(page, `route-${event}-app`).checked).toBe(true)
      expect(box(page, `route-${event}-app`).disabled).toBe(true)
    }
    for (const event of ['daily', 'weekly', 'joined']) expect(box(page, `route-${event}-app`).checked).toBe(false)

    server.devices.push({ id: 'phone', account: robin, name: 'iPhone', created_at: '2026-11-07T08:00:00Z', last_seen: null })
    await unmount()
    const again = await mount(server, '/settings/notifications')
    expect(again.querySelector('[data-testid="channel-app"]')?.textContent).toContain('1 device paired')
    expect(box(again, 'route-assigned-app').disabled).toBe(false)
    await click(box(again, 'route-assigned-app'))
    expect(server.notifyOf(robin).routes.assigned).toEqual(['webpush'])
    expect(box(again, 'route-assigned-app').checked).toBe(false)
    await click(box(again, 'route-daily-app'))
    expect(server.notifyOf(robin).routes.daily).toEqual(['app'])
    expect(box(again, 'route-daily-webpush').disabled).toBe(true)
  })

  it('count the devices in "iPhone and iPad" and list each with its kinds of notification (geraete 0.1.0)', async () => {
    const { server, robin } = smallWorld()
    server.devices.push({ id: 'phone', account: robin, name: 'Robins iPhone', created_at: '2026-11-07T08:00:00Z', last_seen: null })
    const page = await mount(server, '/settings/notifications')
    expect(page.querySelector('[data-testid="notify-devices-box"]')?.textContent).toContain('1 device connected')
    expect(page.querySelector('[data-testid="devices-push-card"]')?.textContent).toContain('Robins iPhone')
  })

  it('become cards with three labelled boxes per row on a narrow screen, boxes as every switch of the settings', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const { server } = smallWorld()
    const page = await mount(server, '/settings/notifications')
    expect(page.querySelector('[data-testid="routes"]')).toBeNull()
    const card = page.querySelector('[data-testid="route-cards"] [data-testid="row-assigned"]')!
    expect(card.querySelector('input[role="switch"], .nt-switch')).toBeNull()
    const switches = [...card.querySelectorAll('input[type="checkbox"]')]
    expect(switches).toHaveLength(3)
    expect(switches.map((entry) => entry.closest('label')?.textContent)).toEqual(['Mail', 'Browser', 'iPhone/iPad'])
  })

  it('say "Saved." as nexnotes does: one green line, no box', async () => {
    const { server, robin } = smallWorld()
    server.devices.push({ id: 'phone', account: robin, name: 'iPhone', created_at: '2026-11-07T08:00:00Z', last_seen: null })
    const page = await mount(server, '/settings/notifications')
    await click(box(page, 'route-daily-app'))
    const saved = page.querySelector('[data-testid="notifications"] [role="status"]') as HTMLElement
    expect(saved.textContent).toBe('Saved.')
    expect(saved.className).toContain('text-ok-500')
    expect(saved.className).not.toMatch(/\b(?:border|bg-|rounded)/)
  })

  it('turn on mail only once the address is confirmed, then save choices and times', async () => {
    const { server, robin } = withMail()
    const page = await mount(server, '/settings/notifications')
    const daily = box(page, 'route-daily-mail')
    expect(daily.checked).toBe(false)
    expect(daily.disabled).toBe(true)
    expect(page.querySelector('[data-testid="channel-mail"]')?.textContent).toContain('Confirm an address first')

    // The address lives in the profile now (konten): the card "Mail" leads there.
    expect(page.querySelector('[data-testid="notify-mail-change"]')?.getAttribute('href')).toBe('/settings/profile')
    await unmount()
    const profile = await mount(server, '/settings/profile')
    const email = profile.querySelector('input[autocomplete="email"]')
    await type(email, 'robin@example.test')
    await submit(email!.closest('form'))
    // A new address asks for the own password first, once, in a dialog.
    const asked = document.querySelector('[role="dialog"]')!
    await type(asked.querySelector('input[type="password"]'), 'password-123')
    await submit(asked.querySelector('form'))
    expect(server.mails.at(-1)).toMatchObject({ to: 'robin@example.test', kind: 'confirm' })
    expect(profile.querySelector('[data-testid="email-pending"]')?.textContent).toContain('robin@example.test')

    server.confirmMail(server.mails.at(-1)!.token!)
    await unmount()
    const again = await mount(server, '/settings/notifications')
    expect(again.querySelector('[data-testid="notify-mail"]')?.textContent).toContain('robin@example.test')
    await click(again.querySelector('[data-testid="route-daily-mail"]'))
    expect(server.notifyOf(robin).routes.daily).toEqual(['mail'])
    expect((again.querySelector('[data-testid="route-daily-mail"]') as HTMLInputElement).checked).toBe(true)
    await click(again.querySelector('[data-testid="route-assigned-mail"]'))
    expect(server.notifyOf(robin).routes.assigned).toEqual(['webpush', 'app', 'mail'])
    expect(server.notifyOf(robin).routes.weekly ?? []).toEqual([])
  })

  it('list the browsers with notifications, this browser marked, and remove one', async () => {
    const { server, robin } = smallWorld()
    server.webpush.push({ id: 7, account: robin, endpoint: 'https://push.example.com/a', agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0', since: '2026-11-01T09:00:00Z' })
    server.webpush.push({ id: 8, account: robin, endpoint: 'https://push.example.com/b', agent: 'Mozilla/5.0 (Android 15; Mobile) Firefox/144.0', since: '2026-11-02T09:00:00Z' })
    const page = await mount(server, '/settings/notifications')
    const rows = [...page.querySelectorAll('[data-testid="notify-browser-row"]')]
    expect(rows.map((row) => ['Chrome on Windows', 'Firefox on Android'].find((name) => row.textContent?.includes(name)))).toEqual(['Chrome on Windows', 'Firefox on Android'])
    expect(page.querySelector('[data-testid="channel-webpush"]')?.textContent).toContain('2 browsers')
    expect(box(page, 'route-due-webpush').disabled).toBe(false)
    await click(rows[1].querySelector('[data-testid^="notify-remove-"]'))
    expect(server.webpush.map((entry) => entry.id)).toEqual([7])
    expect(page.querySelectorAll('[data-testid="notify-browser-row"]')).toHaveLength(1)
    expect(page.querySelector('[data-testid="push-ios"]')?.textContent).toContain('Add to Home Screen')
  })

  it('put the button for this browser into the head of the column, not only at the bottom', async () => {
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'default' })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => null } }) },
    })
    try {
      const { server } = smallWorld()
      const page = await mount(server, '/settings/notifications')
      const head = page.querySelector('[data-testid="channel-webpush"]')!
      expect(head.querySelector('[data-testid="push-toggle-head"]')?.textContent).toBe('Turn on here')
      expect(page.querySelector('[data-testid="notify-browser-on"]')).not.toBeNull()
    } finally {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it('offer the address the sign-in provider knows, in the profile, taken with the password', async () => {
    const { server, robin } = withMail()
    server.notifyOf(robin).suggestion = 'robin@example.test'
    const page = await mount(server, '/settings/profile')
    const offer = page.querySelector('[data-testid="mail-offer"]')!
    expect(offer.textContent).toContain('robin@example.test')
    expect(offer.textContent).toContain('Use the address from Pocket ID?')
    await click(button(offer, 'Use it'))
    const asked = document.querySelector('[role="dialog"]')!
    await type(asked.querySelector('input[type="password"]'), 'password-123')
    await submit(asked.querySelector('form'))
    expect(server.mails.at(-1)).toMatchObject({ to: 'robin@example.test', kind: 'confirm' })
  })

  it('confirm an address from the link without being asked again', async () => {
    const { server, robin } = withMail()
    server.notifyOf(robin).pending = 'robin@example.test'
    server.mails.push({ to: 'robin@example.test', kind: 'confirm', token: 'nxm_fromthemail' })
    const page = await mount(server, '/confirm-email/nxm_fromthemail')
    expect(page.querySelector('[data-testid="confirmed"]')?.textContent).toContain('robin@example.test')
    expect(server.notifyOf(robin).confirmed).toBe(true)
  })

  it('unsubscribe from a mail only after the button, and only that report', async () => {
    const { server, robin } = withMail()
    Object.assign(server.notifyOf(robin), { confirmed: true, address: 'robin@example.test', routes: { daily: ['mail'], weekly: ['mail'] } })
    const page = await mount(server, `/unsubscribe/${robin}-daily-mail`)
    expect(page.textContent).toContain('Stop getting “My day” by Mail?')
    expect(server.notifyOf(robin).routes.daily).toEqual(['mail'])
    await click(page.querySelector('[data-testid="unsubscribe"]'))
    expect(server.notifyOf(robin).routes.daily).toEqual([])
    expect(server.notifyOf(robin).routes.weekly).toEqual(['mail'])
  })
})

describe('inviting into a space', () => {
  it('sends the link by mail when there is a mail server', async () => {
    const { server, family } = withMail()
    const page = await mount(server, '/today')
    await click(page.querySelector(`[data-space="${family}"] button[aria-label="More about “Family”"]`))
    await click(button(page, 'Members'))
    const form = page.querySelector('[data-testid="invite-mail"]')
    expect(form).not.toBeNull()
    await type(form!.querySelector('input'), 'sam@example.test')
    await submit(form!.querySelector('input'))
    expect(server.mails.at(-1)).toMatchObject({ to: 'sam@example.test', kind: 'invite' })
    expect(document.querySelector('[data-testid="notice"]')?.textContent).toContain('Invitation sent to sam@example.test.')
  })

  it('offers no mail without a mail server', async () => {
    const { server, family } = smallWorld()
    const page = await mount(server, '/today')
    await click(page.querySelector(`[data-space="${family}"] button[aria-label="More about “Family”"]`))
    await click(button(page, 'Members'))
    expect(page.querySelector('[data-testid="invite-mail"]')).toBeNull()
  })
})

describe('"Auf welchem Weg" with notifications blocked in this browser (E59)', () => {
  afterEach(() => {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
    vi.unstubAllGlobals()
  })

  it('still shows "This browser" (locked, saying why) and the browsers with notifications', async () => {
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: async () => 'denied' })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => null } }) },
    })
    const { server, robin } = smallWorld()
    server.webpush.push({ id: 7, account: robin, endpoint: 'https://push.example.com/a', agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0', since: '2026-11-01T09:00:00Z' })
    const page = await mount(server, '/settings/notifications')
    const here = page.querySelector('[data-testid="notify-browser"]') as HTMLElement
    expect(here).not.toBeNull()
    expect(here.textContent).toContain('blocked notifications')
    expect((here.querySelector('[data-testid="notify-browser-on"]') as HTMLButtonElement).disabled).toBe(true)
    expect(page.querySelectorAll('[data-testid="notify-browser-row"]')).toHaveLength(1)
  })
})
