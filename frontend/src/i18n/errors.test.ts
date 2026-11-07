// Every error code of the new server has a sentence in both languages (the server no longer checks it; the codes come
// from vertrag-block1.md and the server's list of 06.11.2026). A refused operation shows a short notice by its code.
import { describe, expect, it } from 'vitest'

import de from './de.json'
import en from './en.json'

/** Codes a request can answer with (`detail.code`). */
export const SERVER_CODES = [
  'not_signed_in', 'bad_client', 'not_found', 'too_large', 'invalid_input', 'too_many', 'app_disabled',
  'app_pairing_disabled', 'app_address_missing', 'app_too_many_pairings', 'app_pairing_unknown', 'invites_disabled',
  'private_space', 'last_manager', 'invite_unknown', 'cursor_expired', 'unknown_timezone', 'forbidden',
  'already_done', 'due_changed', 'parent_missing', 'gone', 'invalid',
]

/** Codes of a `Result` in `/batch` and `/files`, each with its notice. */
export const OP_CODES = ['forbidden', 'invalid', 'parent_missing', 'gone', 'not_found', 'already_done', 'due_changed']

describe('error codes', () => {
  it('each have a sentence in German and English', () => {
    for (const [name, tree] of [['de', de], ['en', en]] as const) {
      const errors = tree.errors as Record<string, string>
      expect(SERVER_CODES.filter((code) => !errors[code]), name).toEqual([])
    }
  })

  it('each op code has its notice in both languages', () => {
    for (const [name, tree] of [['de', de], ['en', en]] as const) {
      const notice = tree.notice as Record<string, string>
      expect(OP_CODES.filter((code) => !notice[code]), name).toEqual([])
    }
  })
})
