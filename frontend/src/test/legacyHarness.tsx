/**
 * Renders a settings page or a part of one the way the app does (router, texts), against `legacy.ts` (the server's
 * older paths). The test file itself mocks `../api/client` with `clientMock` and `../state/auth` with `authMock`
 * (vi.mock is per file).
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import i18n from '../i18n'
import { fake } from './legacy'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1))
  })

/** Lets the page work until no answer is on its way (and none followed), however slow the machine. Still busy after
 * two seconds (an answer held with `hold` and never let go, or a page that keeps asking), it fails the test with the
 * number of answers still out, instead of returning as if everything were in. */
export async function settle(): Promise<void> {
  const until = Date.now() + 2_000
  let quiet = 0
  while (quiet < 2) {
    if (Date.now() >= until) throw new Error(`settle: ${fake.pending} answer(s) still on their way after 2 s`)
    await tick()
    quiet = fake.pending === 0 ? quiet + 1 : 0
  }
}

/** Mounts `ui` and waits until the first load is in (`wait`: false to look at the page while an
 * answer is held back with `hold`). A render that throws fails the test. */
export async function mount(ui: ReactNode, path = '/', wait = true): Promise<HTMLElement> {
  await i18n.changeLanguage('en')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        {ui}
      </MemoryRouter>,
    )
  })
  if (wait) await settle()
  return host
}

export async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

/** Types into an input or textarea the way React notices it. */
export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error('nothing to type into')
  const field = element as HTMLInputElement | HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Picks an option of a select the way React notices it. */
export async function choose(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error('nothing to choose in')
  const field = element as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export async function focus(element: Element | null | undefined): Promise<void> {
  await act(async () => (element as HTMLElement).focus())
}

export async function blur(element: Element | null | undefined): Promise<void> {
  await act(async () => (element as HTMLElement).blur())
}

export async function key(element: Element | null | undefined, name: string): Promise<boolean> {
  let kept = true
  await act(async () => {
    kept = (element as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })
  return kept
}

export function button(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
}

/** `useAuth` for pages that ask who is signed in. */
export function authMock() {
  return {
    useAuth: () => ({ me: { id: 1, name: 'robin', role: 'operator' }, refresh: async () => undefined }),
    safeNext: (next: string | null) => next ?? '/',
  }
}
