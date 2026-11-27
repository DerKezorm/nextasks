/**
 * The shared device module (`vendor/nexgeraete`, geraete 0.1.0) in nextasks: where its browser routes are mounted
 * (`/api/devices`; the addresses of before keep their old answers on the server) and nextasks' client for its cards
 * (its tab header, its errors).
 */
import { api } from '../api/client'
import type { DeviceRequest } from '../vendor/nexgeraete'

export const DEVICES_BASE = '/api/devices'

/** Mein Konto › Verbindungen, where the devices are connected. */
export const CONNECTIONS_HREF = '/settings/connections'

/** Server › Verbindungen, where the operator allows the app and new devices. */
export const SERVER_CONNECTIONS_HREF = '/settings/server-connections'

export const deviceRequest: DeviceRequest = <T,>(path: string, init: Parameters<DeviceRequest>[1] = {}) => api<T>(path, init)
