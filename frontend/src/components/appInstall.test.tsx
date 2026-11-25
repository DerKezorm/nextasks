// nextasks as an installed app, against the fake server: the card "Install on this device" under Settings ›
// Connections (plan "Einstellungen", E6, E28; no longer in the profile), with "Install as app" where the browser offers
// it, the hint Share › Add to Home Screen on iPhone and iPad, a line in the installed app and in a browser that offers
// nothing, and the line about a new version.
import { afterEach, describe, expect, it } from 'vitest'

import { isIos, setPwaState } from '../lib/pwa'
import { smallWorld } from '../test/fakeServer'
import { button, click, mount, settle, unmount } from '../test/harness'

afterEach(async () => {
  await unmount()
  setPwaState({ update: false, installable: false, standalone: false, ios: false })
})

describe('installing as an app', () => {
  it('is offered under Settings › Connections when the browser offers it, no longer in the profile', async () => {
    setPwaState({ installable: true })
    const profile = await mount(smallWorld().server, '/settings/profile')
    expect(profile.querySelector('[data-card="install"]')).toBeNull()
    await unmount()
    const page = await mount(smallWorld().server, '/settings/connections')
    expect(page.querySelector('[data-card="install"]')).not.toBeNull()
    expect(button(page, 'Install as app')).toBeDefined()
    expect(page.querySelector('[data-testid="install"]')?.textContent).toContain('Install as app')
  })

  it('is a hint on iPhone and iPad, where only Share › Add to Home Screen installs', async () => {
    setPwaState({ ios: true })
    const page = await mount(smallWorld().server, '/settings/connections')
    expect(button(page, 'Install as app')).toBeUndefined()
    const hints = [...page.querySelectorAll('[data-testid="install-ios"]')].map((hint) => hint.textContent?.trim())
    expect(hints).toEqual(['On iPhone and iPad: Share › Add to Home Screen.'])
  })

  it('says so in the installed app, and where the browser offers nothing; no button there', async () => {
    setPwaState({ installable: true, ios: true, standalone: true })
    let page = await mount(smallWorld().server, '/settings/connections')
    expect(page.querySelector('[data-testid="install"], [data-testid="install-ios"]')).toBeNull()
    expect(page.querySelector('[data-testid="install-installed"]')?.textContent).toBe('nextasks runs as an app on this device already.')
    await unmount()
    setPwaState({ installable: false, ios: false, standalone: false })
    page = await mount(smallWorld().server, '/settings/connections')
    expect(page.querySelector('[data-testid="install"], [data-testid="install-ios"]')).toBeNull()
    expect(page.querySelector('[data-testid="install-other"], [data-testid="install-firefox"]')).not.toBeNull()
  })

  it('knows iPhone and iPad, also an iPad that asks for the desktop page', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0)).toBe(false)
    expect(isIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36', 10)).toBe(false)
  })
})

describe('a new version', () => {
  it('shows a line with "Reload" while it waits, and none without', async () => {
    let page = await mount(smallWorld().server, '/today')
    expect(page.querySelector('[data-testid="update"]')).toBeNull()
    await unmount()
    setPwaState({ update: true })
    page = await mount(smallWorld().server, '/today')
    expect(page.querySelector('[data-testid="update"]')?.textContent).toBe('A new version of nextasks is here.Reload')
  })
})

describe('without the server', () => {
  it('says so instead of asking to sign in, and goes on once the server answers', async () => {
    const { server } = smallWorld()
    const reach = server.fetcher.bind(server)
    server.fetcher = () => async () => {
      throw new TypeError('Failed to fetch')
    }
    const page = await mount(server, '/today')
    expect(page.querySelector('[data-testid="offline"]')?.textContent).toContain('No connection to the server')
    expect(page.querySelector('input[type="password"]')).toBeNull()
    globalThis.fetch = reach() as typeof fetch
    await click(button(page, 'Try again'))
    await settle()
    expect(page.querySelector('[data-testid="offline"]')).toBeNull()
    expect(page.textContent).toContain('Today')
  })
})
