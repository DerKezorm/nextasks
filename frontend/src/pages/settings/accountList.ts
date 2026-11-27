/** nextasks' side of the operator's account list of the shared account module (konten 0.3.9): what its server can do,
 * and its rows as the module knows them. nextasks has no act of its own in the dialog "Manage". */
import { avatarUrl, type AccountRow } from '../../api/client'
import { capsOf, type AccountCaps, type ListedAccount, type OwnAction } from '../../vendor/nexkonten/konten'

/** What nextasks' server can do for the operator: its own switches (konten 0.3.9, `ACCOUNT_CAPS`) with the standard
 * ones of konten 1.1.0 (`capsOf`: roles, blocking, deleting with 30 days to bring back) and its features (none of
 * storage limit, AI or Immich). */
export const APP_CAPS: AccountCaps = capsOf('nextasks', {
  rename: true,
  roles: true,
  // Roles are changed in the dialog "Manage"; an invitation makes a member, its route takes no role (konten 0.3.10).
  inviteRole: false,
  emailRemove: true,
  resetLink: true,
  factorReset: true,
  signOut: true,
  unlink: true,
})

/** nextasks' own buttons and boxes in the dialog "Manage": none. */
export const APP_OWN_ACTIONS: readonly OwnAction[] = []

/** One row of nextasks' answer as the module's list knows it (the names of the interface stay); `forActions` is kept
 * for the callers. */
export function listedOf(row: AccountRow, ownId: number | undefined, forActions = false): ListedAccount {
  void forActions
  const providers = row.providers ?? []
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
    deletedAt: row.deleted_at ?? null,
    purgeAt: row.purge_at ?? null,
    locked: row.locked,
    lastSeenAt: row.last_seen_at ?? null,
    picture: avatarUrl(row),
  }
}
