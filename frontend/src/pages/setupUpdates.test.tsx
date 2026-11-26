// @vitest-environment jsdom
/**
 * The setup asks once whether nextasks looks for new versions (updates U1): the box of the shared module is ticked by
 * default and its answer goes with the setup; unticked, `update_check` is false.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'

const sent = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }))

vi.mock('../state/auth', () => ({ useAuth: () => ({ status: 'setup', setMe: () => undefined }), safeNext: (next: string) => next }))
vi.mock('../api/client', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { authApi: Record<string, unknown> }>()
  return {
    ...real,
    authApi: {
      ...real.authApi,
      setupState: async () => ({ needs_setup: true, code_required: true, signed_in: false, version: '0.8.0', min_password: 8 }),
      setup: async (body: Record<string, unknown>) => {
        sent.bodies.push(body)
        return { id: 1 }
      },
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let box: HTMLDivElement

beforeEach(async () => {
  await i18n.changeLanguage('de')
  sent.bodies = []
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
})

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
  }
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function fillAndSend(untick: boolean): Promise<Record<string, unknown>> {
  const { SetupPage } = await import('./AuthPages')
  act(() =>
    root.render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    ),
  )
  await settle()
  const tick = box.querySelector<HTMLInputElement>('input[data-testid="setup-update-check"]')!
  expect(tick.parentElement!.textContent).toContain('Nach neuen Versionen sehen')
  // No bell in nextasks (U19): the sentence says the answer stands under About, never "in der Glocke".
  expect(tick.parentElement!.parentElement!.textContent).toContain('Wenn du Einstellungen › Über nextasks öffnest')
  expect(tick.parentElement!.parentElement!.textContent).not.toContain('Glocke')
  expect(tick.checked).toBe(true)
  if (untick) act(() => tick.click())
  const fields = [...box.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')]
  const [code, name, username, , password, again] = fields
  type(code!, 'the-code-of-the-log')
  type(name!, 'Olga')
  type(username!, 'olga')
  type(password!, 'correct horse battery')
  type(again!, 'correct horse battery')
  await act(async () => {
    box.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
  expect(sent.bodies).toHaveLength(1)
  return sent.bodies[0]!
}

describe('the setup and the update check', () => {
  it('sends the box ticked by default', async () => {
    expect((await fillAndSend(false)).update_check).toBe(true)
  })

  it('sends it unticked when the operator says no', async () => {
    expect((await fillAndSend(true)).update_check).toBe(false)
  })
})
