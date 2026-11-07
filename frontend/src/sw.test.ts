// @vitest-environment node
// The service worker (public/sw.js) as the browser runs it, with stand-ins for `self`, the caches and the network:
// /api/… never from the cache and never touched, the page from the network first and the kept one without network,
// built files from the cache first, old caches gone once a new worker takes over, nothing kept without a build, and a
// click on a notification opens a path of the own origin only.
import { describe, expect, it, vi } from 'vitest'

// Node's file module by a name the type check of the web does not follow (as in i18n/used.test.ts).
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (file: string, encoding: string) => string }
const SOURCE = files.readFileSync('public/sw.js', 'utf-8')
const ORIGIN = 'https://tasks.example.test'

type Req = { url: string; method: string; mode: string }
type Res = { body: string; ok: boolean; headers: { get: (name: string) => string | null }; clone: () => Res; type: string }
type Handler = (event: Record<string, unknown>) => void

function answer(body: string, type = 'text/html'): Res {
  const made: Res = { body, ok: true, type: 'basic', headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) }, clone: () => made }
  return made
}

const keyOf = (key: Req | string) => (typeof key === 'string' ? key : new URL(key.url).pathname)

function worker({ built = true }: { built?: boolean } = {}) {
  const listeners: Record<string, Handler> = {}
  const store = new Map<string, Map<string, Res>>()
  const online = { up: true }
  const network = vi.fn(async (request: Req) => {
    if (!online.up) throw new TypeError('Failed to fetch')
    return answer(`net:${new URL(request.url).pathname}`, request.url.includes('/assets/') ? 'text/javascript' : 'text/html')
  })
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map())
      const cache = store.get(name)!
      return {
        put: async (key: Req | string, response: Res) => void cache.set(keyOf(key), response),
        addAll: async (list: { url: string }[]) => {
          for (const entry of list) cache.set(new URL(entry.url, ORIGIN).pathname, answer(`kept:${new URL(entry.url, ORIGIN).pathname}`))
        },
      }
    },
    match: async (key: Req | string) => {
      for (const cache of store.values()) if (cache.has(keyOf(key))) return cache.get(keyOf(key))
      return undefined
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  }
  const shown: { title: string; options: { data: { url: string } } }[] = []
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => void (listeners[type] = handler),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined) },
    registration: { showNotification: async (title: string, options: { data: { url: string } }) => void shown.push({ title, options }) },
  }
  class FakeRequest {
    url: string
    constructor(url: string) {
      this.url = new URL(url, ORIGIN).href
    }
  }
  const code = built ? SOURCE.replace("'__NEXTASKS_BUILD__'", '"b2"').replace('/* __NEXTASKS_SHELL__ */ []', '["/icons/icon-192.png","/assets/index-b2.js"]') : SOURCE
  new Function('self', 'caches', 'fetch', 'Request', code)(self, caches, network, FakeRequest)

  /** Sends a request through the worker: the answer it gives, or "untouched" when it leaves it to the browser. */
  async function get(path: string, init: Partial<Req> = {}): Promise<string> {
    let given: Promise<Res> | null = null
    listeners.fetch({ request: { url: ORIGIN + path, method: 'GET', mode: 'cors', ...init }, respondWith: (response: Promise<Res>) => void (given = response) })
    if (!given) return 'untouched'
    return (await (given as Promise<Res>)).body
  }
  async function lifecycle(type: 'install' | 'activate') {
    let done: Promise<unknown> = Promise.resolve()
    listeners[type]({ waitUntil: (work: Promise<unknown>) => void (done = work) })
    await done
  }
  async function push(data: Record<string, unknown>) {
    let done: Promise<unknown> = Promise.resolve()
    listeners.push({ data: { json: () => data }, waitUntil: (work: Promise<unknown>) => void (done = work) })
    await done
    return shown.at(-1)!.options.data.url
  }
  return { get, lifecycle, push, network, online, store, self }
}

describe('the service worker', () => {
  it('never answers /api from the cache and never keeps it', async () => {
    const sw = worker()
    await sw.lifecycle('install')
    for (const path of ['/api/app/1/changes?since=0', '/api/notify', '/api', '/api/auth/me']) {
      expect(await sw.get(path)).toBe('untouched')
      expect(await sw.get(path, { mode: 'navigate' })).toBe('untouched')
    }
    sw.online.up = false
    expect(await sw.get('/api/app/1/changes')).toBe('untouched')
    expect([...sw.store.values()].some((cache) => [...cache.keys()].some((key) => key.startsWith('/api')))).toBe(false)
  })

  it('takes the page from the network first and the kept one only without network', async () => {
    const sw = worker()
    await sw.lifecycle('install')
    expect(await sw.get('/lists/abc', { mode: 'navigate' })).toBe('net:/lists/abc')
    expect(sw.store.get('nextasks-shell-b2')?.get('/index.html')?.body).toBe('net:/lists/abc')
    sw.online.up = false
    expect(await sw.get('/today', { mode: 'navigate' })).toBe('net:/lists/abc')
  })

  it('takes built files from the cache first, and leaves other requests alone', async () => {
    const sw = worker()
    await sw.lifecycle('install')
    expect(await sw.get('/assets/index-b2.js')).toBe('kept:/assets/index-b2.js')
    expect(await sw.get('/assets/other-c3.js')).toBe('net:/assets/other-c3.js')
    const calls = sw.network.mock.calls.length
    expect(await sw.get('/assets/other-c3.js')).toBe('net:/assets/other-c3.js')
    expect(sw.network.mock.calls.length).toBe(calls)
    expect(await sw.get('/lists/abc', { method: 'POST' })).toBe('untouched')
    expect(await sw.get('/sw.js')).toBe('untouched')
  })

  it('throws away the caches of older versions when it takes over', async () => {
    const sw = worker()
    for (const name of ['nextasks-shell-a1', 'nextasks-shell-b2', 'someone-else']) sw.store.set(name, new Map())
    await sw.lifecycle('activate')
    expect([...sw.store.keys()].sort()).toEqual(['nextasks-shell-b2', 'someone-else'])
    expect(sw.self.clients.claim).toHaveBeenCalled()
  })

  it('keeps nothing without a build (the dev server) and takes over at once', async () => {
    const sw = worker({ built: false })
    await sw.lifecycle('install')
    expect(sw.self.skipWaiting).toHaveBeenCalled()
    expect(await sw.get('/today', { mode: 'navigate' })).toBe('untouched')
    expect(await sw.get('/assets/index-b2.js')).toBe('untouched')
  })

  it('waits as a new version until the page says reload', async () => {
    const sw = worker()
    await sw.lifecycle('install')
    expect(sw.self.skipWaiting).not.toHaveBeenCalled()
  })

  it('opens a path of the own origin from a notification, else the task, else Today', async () => {
    const sw = worker()
    expect(await sw.push({ title: 'My day', text: '3 due today', type: 'daily', url: '/today' })).toBe('/today')
    expect(await sw.push({ title: 'x', url: '//evil.example/x', list_id: 'l1', reminder_id: 'r1' })).toBe('/lists/l1?reminder=r1')
    expect(await sw.push({ title: 'x', url: 'https://evil.example/x' })).toBe('/today')
  })
})
