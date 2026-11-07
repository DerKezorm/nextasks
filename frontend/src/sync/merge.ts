/**
 * The rule per field (data model, "Regel"): a value wins when its clock is greater, or with the same clock when it
 * is canonically greater (RFC 8785, UTF-8 bytes). Equal values change nothing.
 */
import { fieldsOf, valueOf } from './fields'
import { compareCanonical } from './jcs'
import type { Clock, Data, Kind } from './types'

/** Whether `value` with `clock` replaces `stored` with `storedClock`. */
export function wins(clock: number, value: unknown, storedClock: number, stored: unknown): boolean {
  if (clock !== storedClock) return clock > storedClock
  return compareCanonical(value, stored) > 0
}

/**
 * Lays a change (`fields` with `clock` per key) over a record: each key wins or loses on its own. Returns the keys
 * that were taken. `data` and `dataClock` change in place.
 */
export function mergeInto(kind: Kind, data: Data, dataClock: Clock, fields: Data, clock: Clock): string[] {
  const taken: string[] = []
  for (const [key, time] of Object.entries(clock)) {
    if (!wins(time, valueOf(kind, key, fields), dataClock[key] ?? 0, valueOf(kind, key, data))) continue
    for (const field of fieldsOf(kind, key)) data[field] = structuredClone(fields[field] ?? null)
    dataClock[key] = time
    taken.push(key)
  }
  return taken
}

/** The rule as a word: `take` the incoming value, `keep` the stored one, or `same` (nothing changes). */
export function outcome(stored: unknown, storedClock: number, incoming: unknown, incomingClock: number): 'take' | 'keep' | 'same' {
  if (wins(incomingClock, incoming, storedClock, stored)) return 'take'
  return incomingClock === storedClock && compareCanonical(incoming, stored) === 0 ? 'same' : 'keep'
}
