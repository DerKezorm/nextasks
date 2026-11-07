/**
 * Renders the whole web (sign-in state, router, sync, texts) against a `FakeServer` that stands in for `fetch`, the
 * way the browser sees it. `settle` waits until no answer is on its way.
 */
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'

import App from '../App'
import i18n from '../i18n'
import { AuthProvider } from '../state/auth'
import type { FakeServer } from './fakeServer'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
let server: FakeServer | null = null
const realFetch = globalThis.fetch
export const where = { path: '' }

// eslint-disable-next-line react-refresh/only-export-components
function Where() {
  const location = useLocation()
  useEffect(() => {
    where.path = location.pathname + location.search
  }, [location])
  return null
}

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2))
  })

/** Until no answer is on its way and none followed (two quiet rounds), at most three seconds. */
export async function settle(): Promise<void> {
  const until = Date.now() + 3000
  let quiet = 0
  while (quiet < 3) {
    if (Date.now() > until) throw new Error(`settle: ${server?.pending} answer(s) still on their way`)
    await tick()
    quiet = server && server.pending === 0 ? quiet + 1 : 0
  }
}

export async function mount(fake: FakeServer, path = '/today', ui?: ReactNode): Promise<HTMLElement> {
  server = fake
  globalThis.fetch = fake.fetcher() as typeof fetch
  localStorage.clear()
  await i18n.changeLanguage('en')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <AuthProvider>{ui ?? <App />}</AuthProvider>
      </MemoryRouter>,
    )
  })
  await settle()
  return host
}

export async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  globalThis.fetch = realFetch
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error('nothing to type into')
  const field = element as HTMLInputElement | HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export async function choose(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error('nothing to choose in')
  const field = element as HTMLSelectElement | HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

export async function submit(element: Element | null | undefined): Promise<void> {
  const form = (element as HTMLElement | null)?.closest('form')
  if (!form) throw new Error('no form')
  await act(async () => {
    form.requestSubmit()
  })
  await settle()
}

export async function press(element: Element | null | undefined, key: string): Promise<void> {
  await act(async () => {
    ;(element ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await settle()
}

export async function blur(element: Element | null | undefined): Promise<void> {
  await act(async () => (element as HTMLElement).blur())
  await settle()
}

export async function focus(element: Element | null | undefined): Promise<void> {
  await act(async () => (element as HTMLElement).focus())
}

/** A drag from one element to another, with the data the page sets (jsdom has no DataTransfer). */
export async function drag(from: Element, to: Element, at: 'before' | 'after' | 'into' = 'after'): Promise<void> {
  const store = new Map<string, string>()
  const transfer = {
    setData: (k: string, v: string) => void store.set(k, v),
    getData: (k: string) => store.get(k) ?? '',
    get types() {
      return [...store.keys()]
    },
    effectAllowed: 'move',
    dropEffect: 'move',
  }
  const y = at === 'before' ? 0.1 : at === 'into' ? 0.5 : 0.9
  const fire = (target: Element, name: string) => {
    const event = new MouseEvent(name, { bubbles: true, cancelable: true, clientY: y })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    target.dispatchEvent(event)
  }
  await act(async () => fire(from, 'dragstart'))
  await act(async () => fire(to, 'dragover'))
  await act(async () => fire(to, 'drop'))
  await act(async () => fire(from, 'dragend'))
  await settle()
}

export function button(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
}

export function row(container: ParentNode, title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[data-reminder]')].find((r) => r.getAttribute('aria-label') === title)
}

export function titles(container: ParentNode): string[] {
  return [...container.querySelectorAll('main [data-reminder]')].map((r) => r.getAttribute('aria-label') ?? '')
}
