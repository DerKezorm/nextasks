import i18n from '../i18n'
import { oidcErrorKey, oidcFormErrorKey } from '../vendor/nexoidc/oidc'

/**
 * The sentence for a server's error code, in the language of the page; an unknown code gets the general one. A code
 * of the shared sign-in module (`vendor/nexoidc`) that nextasks has no sentence of its own for takes the module's.
 */
export function errorText(code: string, values: Record<string, unknown> = {}): string {
  const key = `errors.${code}`
  if (i18n.exists(key)) return i18n.t(key, values)
  const shared = oidcErrorKey(code) ?? oidcFormErrorKey(code)
  return shared ? i18n.t(shared, values) : i18n.t('errors.internal_error')
}

/**
 * The sentence for `?error=` on the sign-in and account pages: a code of the shared module only through
 * `oidcErrorKey` (never a raw code from the address), else one of nextasks's own refusals (`managed_by_suite`,
 * `suite_no_account`) by its sentence, else the general one.
 */
export function returnErrorText(code: string): string {
  const shared = oidcErrorKey(code)
  return shared ? i18n.t(shared) : errorText(code)
}
