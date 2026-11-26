// @vitest-environment jsdom
/**
 * Über nextasks on the shared module updates (0.1.1): an operator sees the card "Aktualisierungen" with the state and
 * the sentence naming nextasks' other calls by itself (U11), and switches with the tab's header; a member sees only the
 * own version, no card, and the page never asks for the state (U2, U15).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../i18n'
import { NexuiLanguage } from '../../vendor/nexui'

const who = vi.hoisted(() => ({ role: 'operator' }))

vi.mock('../../state/auth', () => ({
  useAuth: () => ({ me: { id: 1, version: '0.8.0', role: who.role, timezone: 'Europe/Berlin' } }),
}))
vi.mock('../../lib/whatsNew', () => ({ useWhatsNew: () => ({ entry: null }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ABOUT = { version: '0.8.0', license: 'AGPL-3.0', repo_url: 'https://github.com/DerKezorm/nextasks', releases_url: 'https://github.com/DerKezorm/nextasks/releases', project_url: '' }
const STATE = { update_check: true, checked: true, latest: 'v9.0.0', newer: true, checked_at: '2026-11-26T09:12:00Z', release_url: 'https://github.com/DerKezorm/nextasks/releases/tag/v9.0.0', hidden: false }

let root: Root
let box: HTMLDivElement
let calls: { path: string; method: string; tab: string | null }[]

beforeEach(async () => {
  await i18n.changeLanguage('de')
  calls = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', tab: new Headers(init.headers).get('X-Nextasks-Client') })
    const body = path === '/api/about' ? ABOUT : init.method === 'PUT' ? { ...STATE, update_check: false } : STATE
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
  }
}

async function show(): Promise<void> {
  const { AboutArea } = await import('./AboutArea')
  act(() =>
    root.render(
      <NexuiLanguage language="de">
        <AboutArea />
      </NexuiLanguage>,
    ),
  )
  await settle()
}

describe('Über nextasks', () => {
  it("shows the operator the state and names nextasks' other calls", async () => {
    who.role = 'operator'
    await show()
    expect(box.textContent).toContain('Version 9.0.0 ist erschienen')
    expect(box.textContent).toContain('Von sich aus ruft nextasks außerdem: den Push-Dienst push.nexapps.dev')
    expect(box.textContent).not.toContain('Sonst ruft nextasks von sich aus niemanden an.')
    const daily = box.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(daily).not.toBeNull()
    act(() => daily!.click())
    await settle()
    const put = calls.find((call) => call.method === 'PUT')
    expect(put?.path).toBe('/api/about/updates')
    expect(put?.tab).toBeTruthy()
  })

  it('shows a member only the own version and never asks for the state', async () => {
    who.role = 'member'
    await show()
    expect(box.textContent).toContain('0.8.0')
    expect(box.textContent).not.toContain('9.0.0')
    expect(box.textContent).not.toContain('Aktualisierungen')
    expect(box.querySelector('input[type="checkbox"]')).toBeNull()
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/about'])
  })
})
