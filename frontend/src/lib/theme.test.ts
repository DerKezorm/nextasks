/**
 * What the page hands the server when an account of before has chosen no mode yet (konten 1.1.0, E45): the value this
 * browser really kept, raw, or nothing; never what the browser prefers (`prefers-color-scheme`), never a default worked
 * out here. The server then keeps nextasks' default of before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { storedRaw } from './theme'

function prefersLight(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('light'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('the value the account takes from this browser', () => {
  it('is nothing when the browser kept nothing, whatever the system prefers', () => {
    prefersLight()
    expect(storedRaw()).toBe('')
  })

  it('is what the browser kept, as it is', () => {
    prefersLight()
    for (const kept of ['dark', 'light', 'system']) {
      localStorage.setItem('nextasks.theme', kept)
      expect(storedRaw()).toBe(kept)
    }
  })
})
