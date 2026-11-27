import { ApiError } from '../api/client'
import i18n from '../i18n'
import { accountErrorKeyOf } from '../vendor/nexkonten/konten'
import { mailErrorKey } from '../vendor/nexpost/post'
import { oidcErrorKey, oidcFormErrorKey } from '../vendor/nexoidc/oidc'

/** The codes nextasks answered with before the shared account module, and the module's names for them (the server's
 * `konten_store.OLD_CODES` the other way round). */
export const OLD_ACCOUNT_CODES: Readonly<Record<string, string>> = {
  name_taken: 'username_taken',
  invalid_account_name: 'username_invalid',
  invalid_email: 'email_invalid',
  totp_code_wrong: 'code_wrong',
  second_factor_expired: 'sign_in_expired',
  fresh_sign_in_required: 'fresh_sign_in_needed',
}

/** Codes the module knows that mean something wider in nextasks (a task, a list that is gone; the address of the
 * authentik card): nextasks' own sentence first. */
const OWN_FIRST = new Set(['not_found', 'public_url_needed'])

/**
 * The sentence for a server's error code, in the language of the page; an unknown code gets the general one. The codes
 * of the shared account and post modules bring their sentences with the modules (`account.*`, `mail.error.*`), the
 * same in every nex app; a code of the shared sign-in module (`vendor/nexoidc`) that nextasks has no sentence of its
 * own for takes that module's.
 */
export function errorText(code: string, values: Record<string, unknown> = {}): string {
  const own = `errors.${code}`
  if (OWN_FIRST.has(code) && i18n.exists(own)) return i18n.t(own, values)
  // The module's own code first where the server sends it beside an old one (konten 0.3.10, `account_code`).
  const accountCode = typeof values.account_code === 'string' ? values.account_code : null
  const account = accountErrorKeyOf({ code, account_code: accountCode }, OLD_ACCOUNT_CODES)
  if (account !== 'account.error.unknown' && i18n.exists(account)) return i18n.t(account, values)
  const mail = mailErrorKey(code)
  if (mail !== 'mail.error.unknown' && i18n.exists(mail)) return i18n.t(mail, values)
  if (i18n.exists(own)) return i18n.t(own, values)
  const shared = oidcErrorKey(code) ?? oidcFormErrorKey(code)
  return shared ? i18n.t(shared, values) : i18n.t('errors.internal_error')
}

/**
 * The sentence for `?error=` on the sign-in and account pages: a code of the shared module only through
 * `oidcErrorKey` (never a raw code from the address), else one of nextasks's own refusals by its sentence, else the
 * general one.
 */
export function returnErrorText(code: string): string {
  const shared = oidcErrorKey(code)
  return shared ? i18n.t(shared) : errorText(code)
}

/** The sentence for whatever went wrong, with the values the server sent along ("at least {{minimum}} characters"). */
export function problemText(error: unknown): string {
  return error instanceof ApiError ? errorText(error.code, error.values) : errorText('internal_error')
}
