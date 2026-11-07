/**
 * Web push in this browser (contract, "Web-Push im Browser"): the service worker `/sw.js`, the browser's permission,
 * the server's VAPID key from `/webpush/key`, and the subscription handed over with `PUT /webpush`. A click on a
 * notification opens `/lists/<list_id>?reminder=<reminder_id>`.
 */
import type { SyncEngine } from '../sync/engine'

export type PushState = 'unsupported' | 'denied' | 'off' | 'on'

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

export async function enablePush(engine: SyncEngine): Promise<PushState> {
  if (!supported()) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const { public_key } = await engine.call<{ public_key: string }>('GET', '/webpush/key')
  const reg = await registration()
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }))
  const json = sub.toJSON()
  await engine.call('PUT', '/webpush', { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } })
  return 'on'
}

export async function disablePush(engine: SyncEngine): Promise<PushState> {
  if (!supported()) return 'unsupported'
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await engine.call('DELETE', '/webpush', { endpoint: sub.endpoint }).catch(() => undefined)
    await sub.unsubscribe()
  }
  return 'off'
}

/** What the server lists this browser under (`mark`: SHA-256 of its push address, hex); null without a subscription. */
export async function ownEndpointMark(): Promise<string | null> {
  if (!supported() || !globalThis.crypto?.subtle) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Where a click on a notification leads (the same rule as in `/sw.js`). */
export function pushTarget(payload: { list_id?: string | null; reminder_id?: string | null; url?: string }): string {
  if (payload.url && payload.url.startsWith('/') && !payload.url.startsWith('//')) return payload.url
  if (!payload.list_id) return '/today'
  return `/lists/${encodeURIComponent(payload.list_id)}` + (payload.reminder_id ? `?reminder=${encodeURIComponent(payload.reminder_id)}` : '')
}
