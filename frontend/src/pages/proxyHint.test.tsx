// The hint under Settings, Server when requests come through a proxy nobody named (Prüfgang 05.10.2026 A5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fake, resetFake } from '../test/legacy'
import { mount, unmount } from '../test/legacyHarness'
import { ProxyHint } from './settings/ServerCards'

vi.mock('../api/client', async (importOriginal) => (await import('../test/legacy')).clientMock(await importOriginal()))
vi.mock('../state/auth', async () => (await import('../test/legacyHarness')).authMock())

beforeEach(resetFake)
afterEach(unmount)

describe('the proxy hint', () => {
  it('names the setting while a proxy stands in front unnamed', async () => {
    fake.settings = { proxy_unknown: true }
    const page = await mount(<ProxyHint />)
    const hint = page.querySelector('[data-testid="proxy-hint"]')
    expect(hint?.getAttribute('role')).toBe('status')
    expect(hint?.textContent).toContain('NEXTASKS_TRUSTED_PROXIES')
    expect(hint?.textContent).toContain('If no proxy stands in front of nextasks, you can ignore this.')
  })

  it('stays away otherwise', async () => {
    fake.settings = { proxy_unknown: false }
    const page = await mount(<ProxyHint />)
    expect(page.querySelector('[data-testid="proxy-hint"]')).toBeNull()
  })
})
