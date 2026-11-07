/** Ids as the data model wants them: lowercase UUIDs with dashes; v5 for the copy of a repeated reminder. */

export function uuid4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(bytes)
}

function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function parse(id: string): Uint8Array {
  const hex = id.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('not a uuid')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** SHA-1, small and synchronous (only for UUIDv5, never for anything secret). */
export function sha1(data: Uint8Array): Uint8Array {
  const length = data.length
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16)
  for (let i = 0; i < length; i++) words[i >> 2] |= data[i] << (24 - (i % 4) * 8)
  words[length >> 2] |= 0x80 << (24 - (length % 4) * 8)
  words[words.length - 1] = length * 8
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let block = 0; block < words.length; block += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[block + i]
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const view = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => view.setUint32(i * 4, h))
  return out
}

/** UUIDv5 of `name` in the namespace `namespace` (RFC 4122), lowercase. */
export function uuid5(namespace: string, name: string): string {
  const ns = parse(namespace)
  const text = new TextEncoder().encode(name)
  const all = new Uint8Array(ns.length + text.length)
  all.set(ns)
  all.set(text, ns.length)
  const hash = sha1(all).slice(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  return format(hash)
}
