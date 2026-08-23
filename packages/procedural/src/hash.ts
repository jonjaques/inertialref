/*
 * Integer mixing primitives.
 *
 * Everything here is 32-bit integer arithmetic via `Math.imul` and shifts, which
 * is exactly specified by ECMAScript. That matters more than it looks: the same
 * address must generate the same star in Chrome, in a Web Worker, in Node tests
 * and eventually on a server, and floating-point-based hashing does not promise
 * that. No `Math.random`, no `Date`, no host-dependent behavior.
 */

/** MurmurHash3 32-bit finalizer. Good avalanche, four instructions. */
export function mix32(value: number): number {
  let h = value | 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85eb_ca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2_ae35)
  h ^= h >>> 16
  return h >>> 0
}

export function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

/**
 * MurmurHash3 x86_32 over a string's UTF-16 code units.
 *
 * Code units rather than UTF-8 bytes: addresses are ASCII by construction, the
 * two agree there, and skipping the encode keeps this allocation-free.
 */
export function hashString(text: string, seed = 0): number {
  let h1 = seed >>> 0
  const c1 = 0xcc9e_2d51
  const c2 = 0x1b87_3593
  for (let i = 0; i < text.length; i += 1) {
    let k1 = text.charCodeAt(i)
    k1 = Math.imul(k1, c1)
    k1 = rotl32(k1, 15)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
    h1 = rotl32(h1, 13)
    h1 = (Math.imul(h1, 5) + 0xe654_6b64) | 0
  }
  h1 ^= text.length
  return mix32(h1)
}

/** Mix two 32-bit values into one. Used for lattice coordinates in noise. */
export function hash2(a: number, b: number): number {
  return mix32(
    (Math.imul(a | 0, 0x9e37_79b1) ^ Math.imul(b | 0, 0x85eb_ca6b)) | 0,
  )
}

export function hash3(a: number, b: number, c: number): number {
  return mix32(
    (Math.imul(a | 0, 0x9e37_79b1) ^
      Math.imul(b | 0, 0x85eb_ca6b) ^
      Math.imul(c | 0, 0xc2b2_ae35)) |
      0,
  )
}
