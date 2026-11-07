/*
 * nextasks service worker: the installed app's shell, and web push.
 *
 * The shell: the build writes its own stamp and the list of its files into this file (vite.config.ts, plugin
 * "service-worker"), so every build is a new worker and the page offers "New version – reload". It keeps the start
 * page and the built files, so the installed app also starts without the network; the data come and go through the
 * sync layer as always.
 *  - The page (every navigation): the network first, the kept start page only without network (or when the network
 *    takes longer than PAGE_WAIT). A new start page names new files: never an old shell after an update.
 *  - Built files under /assets/ (their names carry a hash, they never change): the kept one first.
 *  - The few files of the shell without a hash (symbols, manifest, theme.js): the network first.
 *  - /api/… never: always the network, never kept, never answered from here.
 * Older caches of the shell go once a new worker takes over. Without a build (vite's dev server) nothing is kept.
 *
 * Web push: the payload is {title, text, reminder_id, list_id, type, url?}. A click opens `url` (a path of the own
 * origin, e.g. "/today" for a report), else the list with the reminder, in an open nextasks tab when there is one.
 */
const VERSION = '__NEXTASKS_BUILD__'
const SHELL = /* __NEXTASKS_SHELL__ */ []
const BUILT = !VERSION.startsWith('__')
const PREFIX = 'nextasks-shell-'
const CACHE = PREFIX + VERSION
const START = '/index.html'
/** How long a page may take before the kept start page shows (the network's answer still refreshes it). */
const PAGE_WAIT = 4000

/** What happens to a request: 'network' (not touched here), 'page', 'asset' or 'file'. */
function strategy(request) {
  if (request.method !== 'GET') return 'network'
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return 'network'
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'network'
  if (!BUILT || url.pathname === '/sw.js') return 'network'
  if (request.mode === 'navigate') return 'page'
  if (url.pathname.startsWith('/assets/')) return 'asset'
  if (SHELL.includes(url.pathname)) return 'file'
  return 'network'
}

async function keep(key, response) {
  if (!response || !response.ok || response.type === 'opaque') return
  const cache = await caches.open(CACHE)
  await cache.put(key, response)
}

async function page(request) {
  const network = fetch(request).then(async (response) => {
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) await keep(START, response.clone())
    return response
  })
  const kept = await caches.match(START)
  if (!kept) return network
  const late = new Promise((resolve) => setTimeout(() => resolve(kept), PAGE_WAIT))
  return Promise.race([network.catch(() => kept), late])
}

async function asset(request) {
  const kept = await caches.match(request)
  if (kept) return kept
  const response = await fetch(request)
  await keep(request, response.clone())
  return response
}

async function file(request) {
  try {
    const response = await fetch(request)
    await keep(request, response.clone())
    return response
  } catch (error) {
    const kept = await caches.match(request, { ignoreSearch: true })
    if (kept) return kept
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const how = strategy(event.request)
  if (how === 'network') return
  event.respondWith(how === 'page' ? page(event.request) : how === 'asset' ? asset(event.request) : file(event.request))
})

self.addEventListener('install', (event) => {
  // The first worker takes over at once; a new one waits until the page says "reload" (or every tab is closed).
  if (!BUILT) {
    self.skipWaiting()
    return
  }
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([START, ...SHELL].map((path) => new Request(path, { cache: 'reload' })))))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'reload') self.skipWaiting()
})

/** Where a click on a notification leads: a path of the own origin, else the list with the reminder, else Today. */
function target(data) {
  if (typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//')) return data.url
  if (data.list_id) return '/lists/' + encodeURIComponent(data.list_id) + (data.reminder_id ? '?reminder=' + encodeURIComponent(data.reminder_id) : '')
  return '/today'
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'nextasks', text: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(String(data.title || 'nextasks').slice(0, 100), {
      body: String(data.text || '').slice(0, 200),
      icon: '/icons/icon-192.png',
      badge: '/logo.svg',
      // One per task; a new report replaces the one before.
      tag: data.reminder_id ? String(data.reminder_id) : data.type === 'daily' || data.type === 'weekly' ? data.type : undefined,
      data: { url: target(data) },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/today'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      for (const tab of tabs) {
        if (new URL(tab.url).origin === self.location.origin && 'navigate' in tab) {
          return tab.focus().then(() => tab.navigate(url))
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
