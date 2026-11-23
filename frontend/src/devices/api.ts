/**
 * The iPhone app in the browser (`backend/app/routers/app_pairing.py`): the paired devices and the pairing by QR code
 * or short code. Built as nexnotes' (`devices/api.ts` there), with what nextasks' server answers.
 */
import { api, ApiError } from '../api/client'
import { errorText } from '../lib/errors'

/** A paired iPhone or iPad. The server names no kind of device and nothing about notifications. */
export type AppDevice = {
  id: number
  name: string
  created_at: string
  last_seen: string | null
}

export type Pairing = {
  id: string
  /** `ABCD-EFGH`: typed in the app under "Code" with the address, for a device without a camera. */
  code: string
  expires_at: string
  /** The address the app keeps. */
  address: string
  /** `nextasks://connect?address=…&pairing=…&secret=…`, drawn as the QR code. */
  link: string
  qr_svg: string
}

export type PairingState = { state: 'waiting' | 'connected' | 'expired'; device: string }

export const devicesApi = {
  list: () => api<AppDevice[]>('/api/app-devices'),
  disconnect: (id: AppDevice['id']) => api<void>(`/api/app-devices/${id}`, { method: 'DELETE' }),
  pair: () => api<Pairing>('/api/app-pairing', { method: 'POST', body: { address: window.location.origin } }),
  state: (id: string) => api<PairingState>(`/api/app-pairing/${encodeURIComponent(id)}`),
  withdraw: (id: string) => api<void>(`/api/app-pairing/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** The QR code as a picture: an image, never markup put into the page. */
export function qrSource(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** What the server's refusal means, in words: the operator's switches (`app_disabled`, `app_pairing_disabled`) too. */
export function problemOf(error: unknown): string {
  return errorText(error instanceof ApiError ? error.code : 'internal_error')
}
