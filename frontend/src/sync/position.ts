/**
 * Order keys (data model, "Reihenfolge"): `generateKeyBetween` of `fractional-indexing`, compared byte by byte, equal
 * keys ordered by `id`. Server, web and app write the same keys (`pruefsaetze/position.json`).
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

export function keyBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a ?? null, b ?? null)
}

export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  return generateNKeysBetween(a ?? null, b ?? null, n)
}

/** Byte order of the keys (they are ASCII), then the id. */
export function byPosition<T extends { position: string | null; id: string }>(a: T, b: T): number {
  const x = a.position ?? ''
  const y = b.position ?? ''
  if (x !== y) return x < y ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The key for a record dropped at `index` among `siblings` (sorted, without the record itself). When the neighbours
 * carry the same key there is no room between them: the one with the greater id gets a new key in the same step
 * (`moved`), as the data model asks.
 */
export function placeAt<T extends { position: string; id: string }>(all: T[], index: number): { key: string; moved: { id: string; position: string }[] } {
  // A neighbour with a key the library could not have made is passed over (Festlegung 26).
  const siblings = all.filter((s) => isValidKey(s.position))
  index = Math.min(index, siblings.length)
  const before = index > 0 ? siblings[index - 1] : null
  const after = index < siblings.length ? siblings[index] : null
  const moved: { id: string; position: string }[] = []
  if (before && after && before.position >= after.position) {
    // Same key on both sides: the later one (greater id) moves behind, up to the next distinct key.
    const next = siblings.slice(index + 1).find((s) => s.position > after.position) ?? null
    const fresh = keyBetween(after.position, next?.position ?? null)
    moved.push({ id: after.id, position: fresh })
    return { key: keyBetween(before.position, fresh), moved }
  }
  return { key: keyBetween(before?.position ?? null, after?.position ?? null), moved }
}

/** A key after the last of `siblings`. */
export function keyAtEnd(siblings: { position: string | null }[]): string {
  const last = siblings.reduce<string | null>((max, s) => (s.position && isValidKey(s.position) && (max === null || s.position > max) ? s.position : max), null)
  return keyBetween(last, null)
}

/** A key before the first of `siblings`. */
export function keyAtStart(siblings: { position: string | null }[]): string {
  const first = siblings.reduce<string | null>((min, s) => (s.position && isValidKey(s.position) && (min === null || s.position < min) ? s.position : min), null)
  return keyBetween(null, first)
}

const BASE62 = /^[0-9A-Za-z]+$/
const SMALLEST = 'A' + '0'.repeat(26)

/**
 * Whether a key from the network is one `fractional-indexing` could have made: head letter, length of the integer
 * part, no trailing `0`, not the smallest integer, and Base62 throughout (the library does not check the fraction's
 * characters, Festlegung 26).
 */
export function isValidKey(key: unknown): boolean {
  if (typeof key !== 'string' || !BASE62.test(key)) return false
  const head = key[0]
  const length = head >= 'a' && head <= 'z' ? head.charCodeAt(0) - 97 + 2 : head >= 'A' && head <= 'Z' ? 90 - head.charCodeAt(0) + 2 : 0
  if (!length || key.length < length) return false
  if (key.slice(0, length) === SMALLEST) return false
  return !key.slice(length).endsWith('0')
}
