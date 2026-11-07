/**
 * Calls to `/api/app/1` the way the web makes them: with the session cookie and `X-Nextasks-Client: web`. Errors come
 * back as `AppError` with the server's code and, for 429, the seconds to wait.
 */

export const APP_BASE = '/api/app/1'

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfter: number | null = null,
    public readonly values: Record<string, unknown> = {},
  ) {
    super(code)
  }

  /** Worth trying again later: too many requests, the server broke, or no network. */
  get passing(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface Transport {
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>
  upload<T>(path: string, form: FormData): Promise<T>
}

export function httpTransport(fetcher: Fetch = (input, init) => fetch(input, init), base = APP_BASE): Transport {
  const call = async <T>(method: string, path: string, init: RequestInit): Promise<T> => {
    let response: Response
    try {
      response = await fetcher(base + path, { ...init, method, credentials: 'same-origin' })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      throw new AppError(0, 'network')
    }
    if (response.status === 204) return undefined as T
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = data?.detail
      const retry = Number(response.headers.get('Retry-After'))
      const { code, message: _message, ...values } = detail && typeof detail === 'object' && typeof detail.code === 'string' ? detail : { code: response.status === 401 ? 'not_signed_in' : 'internal_error' }
      throw new AppError(response.status, code, Number.isFinite(retry) && retry > 0 ? retry : null, values)
    }
    return data as T
  }
  return {
    json: (method, path, body, signal) =>
      call(method, path, {
        headers: { Accept: 'application/json', 'X-Nextasks-Client': 'web', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      }),
    upload: (path, form) => call('POST', path, { headers: { Accept: 'application/json', 'X-Nextasks-Client': 'web' }, body: form }),
  }
}
