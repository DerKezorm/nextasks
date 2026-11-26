// @vitest-environment jsdom
/**
 * The log and the backups show their moments in the account's time zone (E14, decided E40), not the browser's: the
 * tests run in Europe/Berlin, the account lives in Pacific/Auckland. 09:00 UTC on 21 November 2026 is 10:00 in
 * Berlin and 22:00 in Auckland.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../i18n'
import { NexuiLanguage } from '../../vendor/nexui'

const AT = '2026-11-21T09:00:00+00:00'

vi.mock('../../state/auth', () => ({
  useAuth: () => ({ me: { id: 1, timezone: 'Pacific/Auckland', sign_in: 'password', role: 'operator' } }),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    api: async (path: string) => {
      if (path === '/api/logs/level') return { mode: 'normal', until: null, fixed_by_env: false, variable: 'NEXTASKS_LOG_LEVEL', modes: ['quiet', 'normal', 'detailed', 'trace'], durations: [30, 60, 120, 480] }
      if (path === '/api/logs') return [{ time: '2026-11-21 10:00:00', level: 'INFO', logger: 'nextasks.sync', message: 'line one', request_id: null, user: null, at: AT }]
      throw new Error(`unexpected ${path}`)
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let box: HTMLDivElement

beforeEach(async () => {
  await i18n.changeLanguage('de')
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
  // The log asks after its search field waited 250 ms.
  for (let round = 0; round < 80; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

describe("moments in the account's time zone", () => {
  it('in the log', async () => {
    const { LogCard } = await import('./LogCard')
    act(() =>
      root.render(
        <NexuiLanguage language="de">
          <LogCard />
        </NexuiLanguage>,
      ),
    )
    await settle()
    const row = box.querySelector('[data-testid="log-row"]')!
    expect(row.textContent).toContain('22:00')
    expect(row.textContent).not.toContain('10:00')
  })

  it('in the backups', async () => {
    vi.stubGlobal('fetch', async (path: string) => {
      const body = path.endsWith('/backups')
        ? { schedule: { every: 'daily', time: '03:00', keep: 7 }, zone: 'Europe/Berlin', last: AT, count: 1, kept: 1, failure: null, running: false, restore_failure: null, restored: null, restore: 'restart', download_password: false,
            backups: [{ name: 'nextasks-2026-11-21-090000.zip', size: 2048, created: AT, kind: 'manual', note: '', version: '0.8.0', uploaded: false, locked: false, readable: true, facts: { tasks: 3, files: 1 } }] }
        : { app: 'nextasks', used: 0, parts: [], complete: true, total: 0, disk_used: 0, free: 0, nearly_full: false, where: {}, network: [] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const { StorageArea } = await import('./StorageArea')
    act(() =>
      root.render(
        <NexuiLanguage language="de">
          <StorageArea />
        </NexuiLanguage>,
      ),
    )
    await settle()
    const card = box.querySelector('[data-card="backup"], [data-card="backups"]') ?? box
    expect(card.textContent).toContain('22:00')
    expect(card.textContent).not.toContain('10:00')
  })
})
