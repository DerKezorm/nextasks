/**
 * nextasks as an installed app (manifest, `/sw.js`): the service worker is signed up at the start, a new one waiting
 * is offered as "New version – reload", and the browser's offer to install (`beforeinstallprompt`) is kept for the
 * entry "Install as app". iPhone and iPad have no such offer: there it is Share › Add to Home Screen. In the
 * installed app (`display-mode: standalone`) none of it shows.
 */
import { useSyncExternalStore } from 'react'

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

type State = {
  /** A new version of the app waits; reloading takes it. */
  update: boolean
  /** The browser offers to install (Chrome, Edge, Android). */
  installable: boolean
  /** Runs as the installed app. */
  standalone: boolean
  /** iPhone or iPad (Share › Add to Home Screen; web push only in the installed app). */
  ios: boolean
}

let state: State = { update: false, installable: false, standalone: false, ios: false }
let offer: InstallPrompt | null = null
let waiting: ServiceWorker | null = null
const listeners = new Set<() => void>()

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function isStandalone(): boolean {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches) return true
  } catch {
    // An old browser without matchMedia: not installed.
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function isIos(agent = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): boolean {
  // iPadOS asks for the desktop page and says "Macintosh"; it is the Mac with a touch screen.
  return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1)
}

function watch(registration: ServiceWorkerRegistration) {
  const offerIfWaiting = () => {
    // Only a worker that replaces one: the very first takes over by itself.
    if (registration.waiting && navigator.serviceWorker.controller) {
      waiting = registration.waiting
      set({ update: true })
    }
  }
  offerIfWaiting()
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') offerIfWaiting()
    })
  })
  // An app open for days still learns of a new version: on every return to it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => undefined)
  })
}

/** Once, at the start. */
export function startApp(): void {
  set({ standalone: isStandalone(), ios: isIos() })
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    offer = event as InstallPrompt
    set({ installable: true })
  })
  window.addEventListener('appinstalled', () => {
    offer = null
    set({ installable: false })
  })
  try {
    window.matchMedia('(display-mode: standalone)').addEventListener('change', () => set({ standalone: isStandalone() }))
  } catch {
    // Stays as it was at the start.
  }
  if (!('serviceWorker' in navigator)) return
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The new worker took over after "reload": now the page comes from it.
    if (!reloading && waiting) {
      reloading = true
      window.location.reload()
    }
  })
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(watch)
    .catch(() => undefined)
}

/** Takes the waiting version: the worker takes over, the page reloads. */
export function takeUpdate(): void {
  if (waiting) waiting.postMessage({ type: 'reload' })
  else window.location.reload()
}

/** The browser's own install question; true when it was accepted. */
export async function install(): Promise<boolean> {
  if (!offer) return false
  const asked = offer
  offer = null
  set({ installable: false })
  await asked.prompt()
  const { outcome } = await asked.userChoice
  return outcome === 'accepted'
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePwa(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/** For the tests. */
export function setPwaState(next: Partial<State>): void {
  set(next)
}
