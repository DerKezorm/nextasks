// "Notifications" in the own account, against the fake server: one table, a column per channel the server lists (mail,
// browser, iPhone/iPad) with its state; without a mail server mail is greyed with the reason, the address is confirmed
// by a link before mail can be turned on, the browsers and the app carry what they carried before, choices and times
// go to the server, a narrow screen gets cards with switches, a link from a mail confirms or unsubscribes, and
// managers invite into a space by mail.
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
    expect(page.textContent).not.toContain('Connections”')
  })

  it('carry on the browsers and the app what came there before, greyed until there is one, and switch it per channel', async () => {
    const { server, robin } = smallWorld()
    const page = await mount(server, '/account?tab=notifications')
    for (const event of ['assigned', 'due', 'changed']) {
      expect(box(page, `route-${event}-webpush`).checked).toBe(true)
      expect(box(page, `route-${event}-app`).checked).toBe(true)
      expect(box(page, `route-${event}-app`).disabled).toBe(true)
    }
    for (const event of ['daily', 'weekly', 'joined']) expect(box(page, `route-${event}-app`).checked).toBe(false)

    server.devices.push({ id: 'phone', account: robin, name: 'iPhone', created_at: '2026-11-07T08:00:00Z', last_seen: null })
    await unmount()
    const again = await mount(server, '/account?tab=notifications')
    expect(again.querySelector('[data-testid="channel-app"]')?.textContent).toContain('1 device paired')
    expect(box(again, 'route-assigned-app').disabled).toBe(false)
    await click(box(again, 'route-assigned-app'))
    expect(server.notifyOf(robin).routes.assigned).toEqual(['webpush'])
    expect(box(again, 'route-assigned-app').checked).toBe(false)
    await click(box(again, 'route-daily-app'))
    expect(server.notifyOf(robin).routes.daily).toEqual(['app'])
    expect(box(again, 'route-daily-webpush').disabled).toBe(true)
  })

  it('become cards with three labelled switches per row on a narrow screen', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const { server } = smallWorld()
    const page = await mount(server, '/account?tab=notifications')
    expect(page.querySelector('[data-testid="routes"]')).toBeNull()
    const card = page.querySelector('[data-testid="route-cards"] [data-testid="row-assigned"]')!
    const switches = [...card.querySelectorAll('input[role="switch"]')]
    expect(switches).toHaveLength(3)
    expect(switches.map((entry) => entry.closest('label')?.textContent)).toEqual(['Mail', 'Browser', 'iPhone/iPad'])
  })

  it('turn on mail only once the address is confirmed, then save choices and times', async () => {
    const { server, robin } = withMail()
    const page = await mount(server, '/account?tab=notifications')
    const daily = box(page, 'route-daily-mail')
    expect(daily.checked).toBe(false)
    expect(daily.disabled).toBe(true)
    expect(page.querySelector('[data-testid="channel-mail"]')?.textContent).toContain('Confirm an address first')

    await type(page.querySelector('[data-testid="mail-input"]'), 'robin@example.test')
    await submit(page.querySelector('[data-testid="mail-input"]'))
    expect(server.mails.at(-1)).toMatchObject({ to: 'robin@example.test', kind: 'confirm' })
    expect(page.querySelector('[data-testid="mail-pending"]')?.textContent).toContain('robin@example.test')

    server.confirmMail(server.mails.at(-1)!.token!)
    await unmount()
    const again = await mount(server, '/account?tab=notifications')
    expect(again.querySelector('[data-testid="mail-address"]')?.textContent).toContain('robin@example.test')
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
    const page = await mount(server, '/account?tab=notifications')
    const rows = [...page.querySelectorAll('[data-testid="browsers"] li')]
    expect(rows.map((row) => row.querySelector('span span')?.textContent)).toEqual(['Chrome on Windows', 'Firefox on Android'])
    expect(page.querySelector('[data-testid="channel-webpush"]')?.textContent).toContain('2 browsers')
    expect(box(page, 'route-due-webpush').disabled).toBe(false)
    await click(button(page, 'Remove Firefox on Android'))
    expect(server.webpush.map((entry) => entry.id)).toEqual([7])
    expect(page.querySelectorAll('[data-testid="browsers"] li')).toHaveLength(1)
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
      const page = await mount(server, '/account?tab=notifications')
      const head = page.querySelector('[data-testid="channel-webpush"]')!
      expect(head.querySelector('[data-testid="push-toggle-head"]')?.textContent).toBe('Turn on here')
      expect(page.querySelector('[data-testid="push-toggle"]')).not.toBeNull()
    } finally {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it('offer the address the sign-in provider knows', async () => {
    const { server, robin } = withMail()
    server.notifyOf(robin).suggestion = 'robin@example.test'
    const page = await mount(server, '/account?tab=notifications')
    expect(page.querySelector('[data-testid="mail-suggestion"]')?.textContent).toContain('robin@example.test')
    await click(button(page.querySelector('[data-testid="mail-suggestion"]')!, 'Confirm this address'))
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
    expect(form!.textContent).toContain('Invitation sent to sam@example.test.')
  })

  it('offers no mail without a mail server', async () => {
    const { server, family } = smallWorld()
    const page = await mount(server, '/today')
    await click(page.querySelector(`[data-space="${family}"] button[aria-label="More about “Family”"]`))
    await click(button(page, 'Members'))
    expect(page.querySelector('[data-testid="invite-mail"]')).toBeNull()
  })
})
