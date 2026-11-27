/**
 * The server's API. Every call names this browser tab in `X-Nextasks-Client` (changes without it are refused, the
 * wall against requests from other sites). Errors come back as `ApiError` with the server's code; the page builds
 * its sentence from `errors.<code>` in the language files.
 */

import type { AuthentikAddress } from '../vendor/nexoidc/oidc'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly values: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

const CLIENT_KEY = 'nextasks.client'
/** Sent on `window` when a request finds that the session is gone: the page goes back to the sign-in. */
export const SIGNED_OUT_EVENT = 'nextasks:signed-out'

function randomId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return 'tab-' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

let clientId: string | null = null

/** One id per tab: sessionStorage survives a reload of the tab but is not shared with other tabs. */
export function tabId(): string {
  if (clientId) return clientId
  try {
    clientId = sessionStorage.getItem(CLIENT_KEY)
    if (!clientId) {
      clientId = randomId()
      sessionStorage.setItem(CLIENT_KEY, clientId)
    }
  } catch {
    clientId = randomId()
  }
  return clientId
}

type Options = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | string[] | undefined>
  body?: unknown
  /** A file as the body (an upload), sent as it is. */
  raw?: Blob
  /** The answer is a file, not JSON. */
  blob?: boolean
  /** Headers of its own, next to the ones every request carries (the password of an upload). */
  headers?: Record<string, string>
}

const BUSY_TRIES = 3
const BUSY_WAIT_MS = 1500

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const repeatable = (options.method ?? 'GET') === 'GET'
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(path, options)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'busy' && repeatable && attempt < BUSY_TRIES)) throw error
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
    }
  }
}

/** The way of the shared modules' pages (updates, wasneu) to their routes: every request names this tab. */
export function moduleFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Nextasks-Client', tabId())
  return fetch(path, { credentials: 'same-origin', ...init, headers })
}

async function once<T>(path: string, options: Options): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
    else if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const headers: Record<string, string> = { ...options.headers, Accept: 'application/json', 'X-Nextasks-Client': tabId() }
  let body: BodyInit | undefined
  if (options.raw) body = options.raw
  else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(url.pathname + url.search, { method: options.method ?? 'GET', headers, body })
  if (response.status === 204) return undefined as T
  if (options.blob && response.ok) return (await response.blob()) as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data?.detail
    if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
      const { code, message: _message, ...values } = detail
      if (code === 'sign_in_required') window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
      throw new ApiError(response.status, code, values)
    }
    throw new ApiError(response.status, response.status === 401 ? 'sign_in_required' : 'internal_error')
  }
  return data as T
}

/** An upload with progress (fetch cannot report it): resolves with the server's answer. */
export function upload<T>(path: string, query: Record<string, string | number>, file: Blob, onProgress?: (part: number) => void): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url.pathname + url.search)
    request.setRequestHeader('X-Nextasks-Client', tabId())
    request.setRequestHeader('Accept', 'application/json')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(request.responseText)
      } catch {
        // no JSON
      }
      if (request.status >= 200 && request.status < 300) return resolve(data as T)
      const detail = (data as { detail?: { code?: string } } | null)?.detail
      reject(new ApiError(request.status, typeof detail?.code === 'string' ? detail.code : 'internal_error', (detail as Record<string, unknown>) ?? {}))
    }
    request.onerror = () => reject(new ApiError(0, 'network'))
    request.send(file)
  })
}

// ---- Types ----------------------------------------------------------------------------------------------------------

export type Me = {
  /** Light, dark or as the device says, for the account on every device (konten 1.1.0); "" not chosen yet. */
  theme?: string
  /** The box "Address not confirmed yet" with "Send link" shows (konten 1.1.0, E23). */
  email_needs_proof?: boolean
  id: number
  name: string
  display_name: string
  role: 'operator' | 'member'
  sign_in: 'password' | 'oidc'
  /** The account has a password of its own (else it signs in through a provider only). */
  has_password?: boolean
  /** When the password was set last (konten 0.3.10); null for a password of 0.8.0. */
  password_changed_at?: string | null
  email: string
  /** The address counts (signing in, a forgotten password); a new one waiting for its link; the name before. */
  email_confirmed?: boolean
  pending_email?: string
  former_name?: string
  /** The address a sign-in provider knows the account by, offered on the profile (konten 0.3.4), and whose it is. */
  provider_email?: string
  provider_email_from?: string
  language: string
  timezone?: string
  two_factor: boolean
  two_factor_recovery_left: number
  /** The module's state of the second factor (`factor.state`): none, required, active, passkey. */
  factor_state?: string
  /** NEXTASKS_SECOND_FACTOR_OFF holds: no second factor is asked of anybody. */
  second_factor_off?: boolean
  /** How many passkeys the account has. */
  passkeys?: number
  avatar: string | null
  version: string
  whats_new_seen: string
  created_at?: string
  last_seen_at?: string | null
  shares_allowed?: boolean
  mail?: boolean
  /** A link for a new address can go out (a mail server and the public address); without, an address counts at once. */
  mail_links?: boolean
  second_factor_setup_required?: boolean
  /** A password account without a second factor of its own, signed in at a provider that checks it: its API tokens
   * wait until it sets one up (they come without that provider). */
  keys_wait_for_second_factor?: boolean
  upload_max_mb?: number
  min_password?: number
  /** The operator allows passkeys (on from the start). */
  passkeys_allowed?: boolean
  /** Passkeys can be added here: a public https address, or the page on localhost (konten 1.1.0, E49). */
  passkeys_can_add?: boolean
  /** A mail when a browser signs in for the first time (on from the start). */
  new_sign_in_mail?: boolean
  /** A password set through a link: the page lists what still has access, until put away. */
  new_password_origin?: string
  /** The password was set through the operator's (or the server's) link: the page says so until put away. */
  password_reset_notice?: boolean
}

export type SetupState = { needs_setup: boolean; code_required: boolean; signed_in: boolean; version: string; min_password: number; data_dir?: string }
/** A button of the sign-in and invitation pages: an active provider of the list (the shared module's `public_list`). */
export type ProviderButton = { slug: string; label: string }
/** `providers`: the buttons, in the operator's order; `passkeys`: signing in with a passkey is allowed; `forgot_mail`:
 * "Forgot your password?" sends a link (a mail server is set up). */
export type Methods = { password: boolean; providers: ProviderButton[]; passkeys?: boolean; forgot_mail?: boolean }
/** An active provider and whether the own account is linked to it (My account › Security). */
export type MyProvider = { slug: string; label: string; linked: boolean; managed: string }
/** A provider as the operator's list shows it; never the secret, only whether one is stored. */
export type OidcProvider = {
  id: number
  slug: string
  label: string
  issuer: string
  client_id: string
  has_secret: boolean
  scopes: string
  enabled: boolean
  auto_create: boolean
  trusts_second_factor: boolean
  /** "" by hand, "authentik" from the button, another program's name while coupled. */
  managed: string
  position: number
  redirect_uri: string
  links: number
  /** False for an entry another program keeps (the shared module's coupling). */
  editable: boolean
}
export type OidcProviderForm = {
  label: string
  slug?: string
  issuer: string
  client_id: string
  client_secret: string
  scopes: string
  enabled: boolean
  auto_create: boolean
  trusts_second_factor: boolean
}
export type ProviderImpact = { issuer_change: number; count: number; only: number; only_names: string[] }
export type AuthentikStep = { key: string; ok: boolean; detail: string; reason?: string; status?: number }
export type AuthentikResult = {
  steps: AuthentikStep[]
  /** With the reason `issuer_change`: how many accounts would have to link again. */
  count?: number
  /** The public address the run stored (the card's suggestion, confirmed); it stays even when a later step failed. */
  public_url?: string
  /** With the reason `public_url_needed`: what the card shows about the address (the same as `oidcApi.address`). */
  address?: AuthentikAddress
}

/** What the server asks before a new public address leaves redirect addresses behind (409 `public_url_change`). */
export type AddressQuestion = { count: number; address: string; hand: number }

// ---- Calls ----------------------------------------------------------------------------------------------------------

export const authApi = {
  setupState: () => api<SetupState>('/api/setup'),
  setup: (body: { display_name: string; name: string; email: string; password: string; password_confirm: string; code: string; language: string; update_check?: boolean }) =>
    api<Me>('/api/setup', { method: 'POST', body }),
  methods: () => api<Methods>('/api/auth/methods'),
  login: (name: string, password: string, remember = true) =>
    api<Me | { second_factor: true; passkey?: boolean; code?: boolean }>('/api/auth/login', { method: 'POST', body: { name, password, remember } }),
  /** "Forgot your password?": the same answer whatever was typed. */
  forgot: (name: string) => api<{ sent: boolean }>('/api/auth/forgot', { method: 'POST', body: { name } }),
  code: (code: string) => api<Me>('/api/auth/login/totp', { method: 'POST', body: { code } }),
  cancelCode: () => api<void>('/api/auth/login/totp/cancel', { method: 'POST' }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  logoutEverywhere: () => api<void>('/api/auth/logout-all', { method: 'POST' }),
  me: () => api<Me>('/api/auth/me'),
  language: (language: string) => api<Me>('/api/me/language', { method: 'PUT', body: { language } }),
  avatar: (picture: Blob) => api<Me>('/api/auth/avatar', { method: 'PUT', raw: picture }),
  removeAvatar: () => api<Me>('/api/auth/avatar', { method: 'DELETE' }),
  /** Display name, username and address with one "Save"; a new username or address with the own password. */
  profile: (change: { display_name?: string; email?: string; name?: string; password?: string }) =>
    api<Me>('/api/me/profile', { method: 'PUT', body: change }),
  /** The link for the waiting address once more, or the waiting address forgotten (the notification state back). */
  resendEmail: () => api<unknown>('/api/me/email/resend', { method: 'POST' }),
  withdrawEmail: () => api<unknown>('/api/me/email/pending', { method: 'DELETE' }),
  newSignInMail: (on: boolean) => api<Me>('/api/me/new-sign-in-mail', { method: 'PUT', body: { on } }),
  /** A link that proves the address the account has (the box "Address not confirmed yet", konten 1.1.0). */
  proveEmail: () => api<unknown>('/api/me/email/prove', { method: 'POST' }),
  /** Light, dark or as the device says, for the account on every device (konten 1.1.0). */
  theme: (theme: string) => api<Me>('/api/me/theme', { method: 'PUT', body: { theme } }),
  /** Once, while the account has none: the value this browser kept before. */
  adoptTheme: (value: string) => api<{ theme: string }>('/api/me/theme/adopt', { method: 'POST', body: { value } }),
  sessions: () => api<SessionEntry[]>('/api/auth/sessions'),
  endSession: (uid: string) => api<void>(`/api/auth/sessions/${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  access: () => api<{ origin: string; access: AccessEntry[] }>('/api/auth/access'),
  disconnectAll: () => api<{ disconnected: number }>('/api/auth/access/disconnect', { method: 'POST' }),
  accessSeen: () => api<Me>('/api/auth/access/seen', { method: 'POST' }),
  resetNoticeSeen: () => api<Me>('/api/me/password-reset-notice/seen', { method: 'POST' }),
  password: (current: string, next: string, confirm: string) =>
    api<void>('/api/auth/password', { method: 'PUT', body: { current, new: next, password_confirm: confirm } }),
  myProviders: () => api<MyProvider[]>('/api/oidc/me'),
  linkStart: (slug: string, password: string) => api<{ url: string }>(`/api/oidc/${encodeURIComponent(slug)}/link`, { method: 'POST', body: { password } }),
  unlink: (slug: string) => api<void>(`/api/oidc/${encodeURIComponent(slug)}/link`, { method: 'DELETE' }),
  /** Takes the address a provider knows the account by, or stops the page from offering it. */
  takeProviderEmail: (password = '') => api<Me>('/api/oidc/me/address', { method: 'POST', body: { password } }),
  declineProviderEmail: () => api<void>('/api/oidc/me/address', { method: 'DELETE' }),
}

/** A browser or a paired iPhone in "Signed-in devices". */
export type SessionEntry = {
  uid: string
  kind: string
  label: string
  address: string
  created_at: string
  last_seen_at: string | null
  current: boolean
  device: boolean
}

/** What still has access after a password set through a link: devices, API tokens, passkeys. */
export type AccessEntry = { id: string; kind: string; label: string; last_used_at: string | null }

/** A passkey of the own account. */
export type PasskeyEntry = { uid: string; name: string; created_at: string; last_used_at: string | null }

export const passkeysApi = {
  list: () => api<PasskeyEntry[]>('/api/auth/passkeys'),
  beginAdd: (password: string) =>
    api<{ token: string; options: Record<string, unknown> }>('/api/auth/passkeys/begin', { method: 'POST', body: { password } }),
  finishAdd: (token: string, credential: unknown, name: string) =>
    api<PasskeyEntry>('/api/auth/passkeys/finish', { method: 'POST', body: { token, credential, name } }),
  remove: (uid: string, password: string) => api<unknown>(`/api/auth/passkeys/${encodeURIComponent(uid)}`, { method: 'DELETE', body: { password } }),
  beginSignIn: () => api<{ token: string; options: Record<string, unknown> }>('/api/auth/passkey/begin', { method: 'POST' }),
  finishSignIn: (token: string, credential: unknown) => api<Me>('/api/auth/passkey/finish', { method: 'POST', body: { token, credential } }),
}

/** A link for a new password (the person's own, the operator's, or the server's emergency command). */
export const resetApi = {
  offer: (token: string) => api<{ name: string; username?: string; min_password: number; expires_at: string }>(`/api/reset/${encodeURIComponent(token)}`),
  use: (token: string, password: string, confirm: string) =>
    api<void>(`/api/reset/${encodeURIComponent(token)}`, { method: 'POST', body: { password, password_confirm: confirm } }),
}

/** What an invitation offers on its page (`GET /api/invite/{token}`): the space and who invites, and the fields of a
 * new account as the shared module fills them (display name, a suggested username, the address). */
export type InviteOffer = {
  space: string | null
  role: string | null
  by?: string | null
  min_password: number
  signed_in_as: string | null
  display_name?: string
  name?: string
  email?: string
  /** Signing in with a password is on. */
  password?: boolean
}

/** An open invitation into nextasks, as the operator's list shows it. */
export type Invite = { id: number; email: string; display_name?: string; by?: string; created_at?: string; expires_at: string; expired?: boolean }

export const invitesApi = {
  offer: (token: string) => api<InviteOffer>(`/api/invite/${encodeURIComponent(token)}`),
  /** A new account through the invitation (also into a space); the answer names the space it joined, if any. */
  accept: (token: string, body: { display_name: string; name: string; email: string; password: string; password_confirm: string }) =>
    api<Me & { space_id?: string | null }>(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST', body }),
  list: () => api<Invite[]>('/api/invites'),
  make: (body: { days: number; email: string; display_name: string; send: boolean; language: string }) =>
    api<Invite & { link: string; sent: boolean }>('/api/invites', { method: 'POST', body }),
  withdraw: (id: number) => api<void>(`/api/invites/${id}`, { method: 'DELETE' }),
}

/** A provider an account is linked to, as a mark in the operator's list (the shared sign-in blueprint 04). */
export type LinkedProvider = { id: number; slug: string; label: string; managed: string }

/** One account of the operator's list (`GET /api/accounts`): the own view without the private parts, and what the
 * list needs (the spaces it is in, a doubled address, its second factor, its providers). */
export type AccountRow = Me & {
  spaces?: number
  email_duplicate?: boolean
  authenticator?: boolean
  locked: boolean
  blocked?: boolean
  blocked_at?: string | null
  /** Deleted (konten 1.1.0) and the day it goes for good: until then the operator brings it back. */
  deleted_at?: string | null
  purge_at?: string | null
  providers?: LinkedProvider[]
}

/** What a reset of the second factor would take away (the shared module's `factor.reset_overview`). */
export type FactorResetOverview = { authenticator: boolean; recovery_codes: number; passkeys: { uid: string; name: string }[]; devices: { uid: string; label: string }[] }

export const accountsApi = {
  list: () => api<AccountRow[]>('/api/accounts'),
  remove: (id: number, current_password: string) => api<void>(`/api/accounts/${id}`, { method: 'DELETE', body: { current_password } }),
  block: (id: number, current_password: string) => api<void>(`/api/accounts/${id}/block`, { method: 'POST', body: { current_password } }),
  unblock: (id: number, current_password: string) => api<void>(`/api/accounts/${id}/unblock`, { method: 'POST', body: { current_password } }),
  /** A deleted account back while its 30 days run (konten 1.1.0). */
  restore: (id: number, current_password: string) => api<void>(`/api/accounts/${id}/restore`, { method: 'POST', body: { current_password } }),
  role: (id: number, role: 'operator' | 'member', current_password: string) =>
    api<AccountRow>(`/api/accounts/${id}/role`, { method: 'PUT', body: { role, current_password } }),
  /** A one-time link with which the person sets a new password themselves; the operator never knows it. */
  resetLink: (id: number, days: number, current_password: string) =>
    api<{ link: string | null; sent?: boolean; expires_at: string }>(`/api/accounts/${id}/reset-link`, { method: 'POST', body: { days, current_password } }),
  /** Another username or display name; the address only taken away, never set (the operator's own password). */
  rename: (id: number, name: string, current_password: string) =>
    api<AccountRow>(`/api/accounts/${id}/name`, { method: 'PUT', body: { name, current_password } }),
  displayName: (id: number, display_name: string, current_password: string) =>
    api<AccountRow>(`/api/accounts/${id}/display-name`, { method: 'PUT', body: { display_name, current_password } }),
  removeEmail: (id: number, current_password: string) => api<AccountRow>(`/api/accounts/${id}/email`, { method: 'DELETE', body: { current_password } }),
  signOut: (id: number) => api<void>(`/api/accounts/${id}/sign-out`, { method: 'POST' }),
  resetOverview: (id: number) => api<FactorResetOverview>(`/api/accounts/${id}/totp/reset`),
  resetSecondFactor: (id: number, current_password: string, disconnect_devices = true, remove_passkeys = true) =>
    api<void>(`/api/accounts/${id}/totp/reset`, { method: 'POST', body: { current_password, disconnect_devices, remove_passkeys } }),
}

/** The operator's provider list and the authentik button (Server › Sign-in; the shared module's routes). */
export const oidcApi = {
  providers: () => api<OidcProvider[]>('/api/oidc/admin/providers'),
  add: (form: OidcProviderForm) => api<OidcProvider>('/api/oidc/admin/providers', { method: 'POST', body: form }),
  save: (id: number, form: OidcProviderForm) => api<OidcProvider & { dropped: number }>(`/api/oidc/admin/providers/${id}`, { method: 'PUT', body: form }),
  remove: (id: number) => api<{ count: number; only: number }>(`/api/oidc/admin/providers/${id}`, { method: 'DELETE' }),
  order: (ids: number[]) => api<ProviderButton[]>('/api/oidc/admin/providers/order', { method: 'PUT', body: { ids } }),
  impact: (id: number, issuer = '') => api<ProviderImpact>(`/api/oidc/admin/providers/${id}/impact`, { query: issuer ? { issuer } : {} }),
  unlinkAccount: (account: number, provider: number, password: string) =>
    api<void>(`/api/oidc/admin/accounts/${account}/links/${provider}`, { method: 'DELETE', body: { current_password: password } }),
  /**
   * `confirm_issuer_change`: the answer to the question the button stops at when another issuer takes the links.
   * `public_url`: the suggested address ("Use it and set up"), only sent while nextasks has none.
   */
  authentik: (url: string, token: string, confirm_issuer_change = false, public_url = '') =>
    api<AuthentikResult>('/api/oidc/authentik/setup', {
      method: 'POST',
      body: { url, token, confirm_issuer_change, ...(public_url ? { public_url } : {}) },
    }),
  /** What the authentik card shows about the public address. */
  address: () => api<AuthentikAddress>('/api/oidc/authentik/address'),
  /** "Use it only": the address becomes the public one; 409 `public_url_change` asks first, `confirm` answers it. */
  saveAddress: (public_url: string, confirm = false) =>
    api<AuthentikAddress>('/api/oidc/authentik/address', { method: 'POST', body: { public_url, confirm } }),
}

/** Server › Sign-in (konten 1.1.0, `signin.view` and the public address). */
export type SignInSettingsView = {
  password_login: boolean
  factor_required: boolean
  passkeys_allowed: boolean
  password_may_go_off: boolean
  factor_may_go_on: boolean
  second_factor_off: boolean
  public_url: string
}

export const signInApi = {
  read: () => api<SignInSettingsView>('/api/server/sign-in'),
  save: (change: Partial<Pick<SignInSettingsView, 'password_login' | 'factor_required' | 'passkeys_allowed'>>, password = '') =>
    api<SignInSettingsView>('/api/server/sign-in', { method: 'PUT', body: { ...change, password } }),
  readiness: <T,>() => api<T>('/api/server/sign-in/readiness'),
}

export type ApiToken = {
  id: number
  name: string
  /** `read`, or `write`: also makes and changes tasks and lists where its account may write. */
  level: 'read' | 'write'
  prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  blocked: boolean
  /** The spaces it may see; null: every space its account may read. */
  spaces: { id: string; name: string }[] | null
}
/** For the operator: `account_display` is the name people see (dialogs say it), `account_blocked` none of them counts. */
export type AnyApiToken = Omit<ApiToken, 'spaces'> & { account: string; account_display: string; account_blocked: boolean; spaces: number | null }

/** API tokens for programs (`/api/v1`). A new one is narrow: chosen spaces, 90 days (as nexbrand's F26). */
export const apiTokensApi = {
  /** `choices`: the spaces a new token may be given (those a token of the account reads, never by operator powers). */
  list: () => api<{ allowed: boolean; tokens: ApiToken[]; choices: { id: string; name: string }[] }>('/api/api-tokens'),
  /** `spaces` null: every space the account may read, now and later, asked for on purpose (`all_spaces`). */
  make: (name: string, spaces: string[] | null, days: number | null, level: 'read' | 'write' = 'read') =>
    api<{ token: ApiToken; secret: string }>('/api/api-tokens', { method: 'POST', body: spaces === null ? { name, all_spaces: true, days, level } : { name, spaces, days, level } }),
  remove: (id: number) => api<void>(`/api/api-tokens/${id}`, { method: 'DELETE' }),
  every: () => api<AnyApiToken[]>('/api/admin/api-tokens'),
  block: (id: number) => api<AnyApiToken>(`/api/admin/api-tokens/${id}/block`, { method: 'POST' }),
}

export function avatarUrl(person: { id: number; avatar: string | null }): string | null {
  return person.avatar ? `/api/avatars/${person.id}?v=${encodeURIComponent(person.avatar)}` : null
}

/** The password for an upload rides in a header, as base64 of its UTF-8: a header carries no umlauts. */
export function passwordHeader(password: string): string {
  let bytes = ''
  for (const byte of new TextEncoder().encode(password)) bytes += String.fromCharCode(byte)
  return btoa(bytes)
}
