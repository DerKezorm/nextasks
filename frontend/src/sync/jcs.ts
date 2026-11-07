/**
 * RFC 8785 (JSON Canonicalization Scheme) for the values nextasks stores: null, booleans, numbers, strings, arrays
 * and plain objects. Keys sorted by UTF-16 code units, numbers and strings as ECMAScript writes them (which is what
 * JCS prescribes). The tie rule of the data model compares two such texts as UTF-8 bytes.
 */

export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('JCS: number not finite')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
    }
    default:
      throw new Error(`JCS: cannot write ${typeof value}`)
  }
}

const encoder = new TextEncoder()

/** Negative when `a` is canonically smaller than `b`, 0 when equal, positive when greater (UTF-8 bytes). */
export function compareCanonical(a: unknown, b: unknown): number {
  const x = encoder.encode(canonical(a))
  const y = encoder.encode(canonical(b))
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}
