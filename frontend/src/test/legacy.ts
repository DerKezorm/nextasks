/**
 * A small stand-in for the server's older paths (settings, sign-in, accounts) in page tests, answered from plain
 * values. Every call is counted in `calls`, so a test sees what the page sent. `refuse` makes the next call of a kind
 * fail like the server would. The app's own paths (`/api/app/1`) are `fakeServer.ts`.
 */
import type { ApiError as RealApiError, MyProvider, OidcProvider, OidcProviderForm, ProviderButton } from '../api/client'
import type { AuthentikAddress } from '../vendor/nexoidc/oidc'

// Only types from the client here: this module builds its mock, so a value import would wait for itself.
type ErrorClass = new (status: number, code: string, values?: Record<string, unknown>) => RealApiError
let ApiError: ErrorClass

type Call = { name: string; args: unknown[] }

export interface FakeState {
  me: number
  /** What `/api/auth/methods` answers (the sign-in page). */
  methods: { password: boolean; providers: ProviderButton[]; suite?: boolean; suite_url?: string }
  /** The operator's provider list (`/api/oidc/admin/providers`) and the own account's rows (`/api/oidc/me`). */
  providers: OidcProvider[]
  myProviders: MyProvider[]
  /** What `/api/settings` answers (the operator's server settings). */
  settings: Record<string, unknown>
  /** What `/api/oidc/authentik/setup` answers: the steps of the authentik button, as the server names them. */
  authentikSteps: { key: string; ok: boolean; detail: string; reason?: string; status?: number }[]
  /** Answers for the next runs of the button (first in, first out); `count` goes with the reason `issuer_change`. */
  authentikRuns: { steps: FakeState['authentikSteps']; count?: number; public_url?: string; address?: AuthentikAddress }[]
  /** What `GET /api/oidc/authentik/address` answers (module 1.0.10). */
  address: AuthentikAddress
  /** The question a new public address meets (409 `public_url_change`) until it comes with `confirm`; null: none. */
  addressAsks: { count: number; address: string; hand: number } | null
  /** What `/api/accounts` and `/api/backups` answer (the operator's lists). */
  accounts: Record<string, unknown>[]
  backups: Record<string, unknown>[]
  calls: Call[]
  refuse: Record<string, { status: number; code: string; values?: Record<string, unknown> }>
  /** Answers of a kind held back until the test lets them go (`hold`). */
  gates: Record<string, Promise<void>>
  /** Answers on their way; `settle` waits until there are none, never on a clock alone. */
  pending: number
}

/** The address view of a server that has a public address and a proxy that passes the scheme on. */
export function emptyAddress(change: Partial<AuthentikAddress> = {}): AuthentikAddress {
  return { public_url: 'https://tasks.example.com', seen: 'http://localhost:3000', forwarded_proto: '', forwarded_host: '', proxy_ignored: false, callback_path: '/api/oidc/authentik/callback', redirect_uri: 'https://tasks.example.com/api/oidc/authentik/callback', registered_redirect_uri: '', stale: false, ...change }
}

export const fake: FakeState = { me: 1, methods: { password: true, providers: [] }, providers: [], myProviders: [], settings: {}, authentikSteps: [], authentikRuns: [], address: emptyAddress(), addressAsks: null, accounts: [], backups: [], calls: [], refuse: {}, gates: {}, pending: 0 }

/** Holds every answer of a kind back until the returned function is called: a test can look at the page in between. */
export function hold(name: string): () => void {
  let release = () => undefined as void
  fake.gates[name] = new Promise<void>((resolve) => {
    release = resolve
  })
  return () => {
    delete fake.gates[name]
    release()
  }
}

/** Nothing set up: the own account, password sign-in, no providers. */
export function resetFake(): void {
  fake.me = 1
  fake.methods = { password: true, providers: [] }
  fake.providers = []
  fake.myProviders = []
  fake.settings = {}
  fake.authentikSteps = []
  fake.authentikRuns = []
  fake.address = emptyAddress()
  fake.addressAsks = null
  fake.accounts = []
  fake.backups = []
  fake.calls = []
  fake.refuse = {}
  fake.gates = {}
  fake.pending = 0
}

/** Answers like the server, a little later (a promise); held back while the test holds its kind (`hold`). */
function answer<T>(name: string, args: unknown[], make: () => T): Promise<T> {
  fake.calls.push({ name, args })
  const refused = fake.refuse[name]
  if (refused) {
    delete fake.refuse[name]
    return Promise.reject(new ApiError(refused.status, refused.code, refused.values))
  }
  fake.pending += 1
  return (fake.gates[name] ?? Promise.resolve())
    .then(
      () =>
        new Promise<T>((resolve, reject) =>
          setTimeout(() => {
            try {
              resolve(structuredClone(make()))
            } catch (error) {
              reject(error)
            }
          }, 1),
        ),
    )
    .finally(() => {
      fake.pending -= 1
    })
}

export function calls(name: string): Call[] {
  return fake.calls.filter((c) => c.name === name)
}

/** The parts of `api/client` the store uses, wired to `fake`; the rest stays as it is. */
export function clientMock(real: Record<string, unknown>) {
  ApiError = real.ApiError as ErrorClass
  let next = 100
  const realApi = real.api as (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
  return {
    ...real,
    // The calls pages make with `api` itself, by address.
    api: (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET'
      if (path === '/api/invites') return answer(method === 'GET' ? 'invites' : 'invite-create', [options.body], () => (method === 'GET' ? [] : { id: 9, link: 'https://tasks.example.com/invite/x', sent: false, email: '' }))
      if (path === '/api/accounts') return answer('accounts', [], () => fake.accounts)
      if (path === '/api/backups' && method === 'GET') return answer('backups', [], () => fake.backups)
      if (path === '/api/settings' && method === 'GET') return answer('settings', [], () => fake.settings)
      if (path === '/api/settings' && method === 'PUT') {
        const body = options.body as { public_url?: string; confirm_address?: boolean }
        return answer('saveSettings', [body], () => {
          if (body.public_url !== undefined && fake.addressAsks && !body.confirm_address) throw new ApiError(409, 'public_url_change', { ...fake.addressAsks })
          fake.settings = { ...fake.settings, ...body }
          delete fake.settings.confirm_address
          return fake.settings
        })
      }
      if (path === '/api/oidc/authentik/setup') return answer('authentik', [options.body], () => fake.authentikRuns.shift() ?? { steps: fake.authentikSteps })
      if (path === '/api/auth/me') return answer('me', [], () => ({ id: fake.me }))
      return realApi(path, options)
    },
    authApi: {
      ...(real.authApi as object),
      me: () => answer('me', [], () => ({ id: fake.me })),
      methods: () => answer('methods', [], () => fake.methods),
      myProviders: () => answer('myProviders', [], () => fake.myProviders),
    },
    // The operator's provider list, kept in `fake.providers` as the server keeps its table.
    oidcApi: {
      ...(real.oidcApi as object),
      providers: () => answer('providers', [], () => fake.providers),
      add: (form: OidcProviderForm) =>
        answer('addProvider', [form], () => {
          const slug = form.slug || 'provider'
          const made: OidcProvider = { id: next++, slug, label: form.label, issuer: form.issuer.replace(/\/+$/, ''), client_id: form.client_id, has_secret: !!form.client_secret, scopes: form.scopes, enabled: form.enabled, auto_create: form.auto_create, trusts_second_factor: form.trusts_second_factor, managed: '', position: fake.providers.length, redirect_uri: `https://tasks.example.com/api/oidc/${slug}/callback`, links: 0, editable: true }
          fake.providers.push(made)
          return made
        }),
      save: (id: number, form: OidcProviderForm) =>
        answer('saveProvider', [id, form], () => {
          const hit = fake.providers.find((entry) => entry.id === id)
          if (!hit) throw new ApiError(422, 'provider_unknown', { field: 'id' })
          Object.assign(hit, { label: form.label, issuer: form.issuer.replace(/\/+$/, ''), client_id: form.client_id, scopes: form.scopes, enabled: form.enabled, auto_create: form.auto_create, trusts_second_factor: form.trusts_second_factor })
          return { ...hit, dropped: 0 }
        }),
      remove: (id: number) =>
        answer('removeProvider', [id], () => {
          fake.providers = fake.providers.filter((entry) => entry.id !== id)
          return { count: 0, only: 0 }
        }),
      order: (ids: number[]) =>
        answer('orderProviders', [ids], () => {
          fake.providers = ids.map((id) => fake.providers.find((entry) => entry.id === id)!).filter(Boolean)
          return fake.providers.map(({ slug, label }) => ({ slug, label }))
        }),
      impact: (id: number, issuer = '') =>
        answer('providerImpact', [id, issuer], () => {
          const hit = fake.providers.find((entry) => entry.id === id)
          const changed = !!issuer && !!hit && hit.issuer !== issuer.replace(/\/+$/, '')
          return { issuer_change: changed ? (hit?.links ?? 0) : 0, count: hit?.links ?? 0, only: 0, only_names: [] }
        }),
      authentik: (url: string, token: string, confirm_issuer_change = false, public_url = '') =>
        answer('authentik', [{ url, token, confirm_issuer_change, public_url }], () => fake.authentikRuns.shift() ?? { steps: fake.authentikSteps }),
      address: () => answer('address', [], () => fake.address),
      saveAddress: (public_url: string, confirm = false) =>
        answer('saveAddress', [{ public_url, confirm }], () => {
          if (fake.addressAsks && !confirm) throw new ApiError(409, 'public_url_change', { ...fake.addressAsks })
          fake.address = { ...fake.address, public_url, redirect_uri: public_url + fake.address.callback_path }
          return fake.address
        }),
    },
  }
}
