/** nextasks' side of the operator's account list of the shared account module (konten 0.3.9): what its server can do,
 * and its rows as the module knows them. nextasks has no act of its own in the dialog "Manage". */
import { avatarUrl, type AccountRow } from '../../api/client'
import type { AccountCaps, ListedAccount, OwnAction } from '../../vendor/nexkonten/konten'

/** What nextasks' server can do for the operator (konten 0.3.9, `ACCOUNT_CAPS`): everything of the module but bringing
 * a deleted account back (nextasks deletes for good; its tasks stay in their spaces). */
export const APP_CAPS: AccountCaps = {
  rename: true,
  roles: true,
  // Roles are changed in the dialog "Manage"; an invitation makes a member, its route takes no role (konten 0.3.10).
  inviteRole: false,
  emailRemove: true,
  resetLink: true,
  factorReset: true,
  signOut: true,
  unlink: true,
  blocking: true,
  remove: true,
  restore: false,
}

/** nextasks' own buttons and boxes in the dialog "Manage": none. */
export const APP_OWN_ACTIONS: readonly OwnAction[] = []

/** Providers an account is linked to through another program (the coupling of the shared sign-in module); that
 * program keeps the link, the operator does not take it here (as before). */
const KEPT_ELSEWHERE = 'nexsuite'

/** One row of nextasks' answer as the module's list knows it (the names of the interface stay). `forActions`: the
 * providers whose link the operator may take, for the buttons "Unlink" (the badges show every provider). */
export function listedOf(row: AccountRow, ownId: number | undefined, forActions = false): ListedAccount {
  const providers = (row.providers ?? []).filter((provider) => !forActions || provider.managed !== KEPT_ELSEWHERE)
  return {
    id: row.id,
    username: row.name,
    displayName: row.display_name ?? '',
    email: row.email ?? '',
    emailConfirmed: row.email_confirmed,
    emailDuplicate: row.email_duplicate,
    operator: row.role === 'operator',
    self: row.id === ownId,
    hasPassword: row.has_password ?? row.sign_in === 'password',
    authenticator: row.authenticator ?? row.two_factor,
    passkeys: row.passkeys ?? 0,
    providers: providers.map((provider) => ({ id: provider.id, label: provider.label })),
    blocked: Boolean(row.blocked),
    blockedAt: row.blocked_at ?? null,
    locked: row.locked,
    lastSeenAt: row.last_seen_at ?? null,
    picture: avatarUrl(row),
  }
}
