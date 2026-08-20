import { invariant } from '@inertialref/shared'
import { hashString, mix32 } from './hash.ts'

/*
 * Hierarchical seed derivation (ADR-0005).
 *
 * A seed is 128 bits held as four uint32 lanes. Content is generated from
 * `derive(parentSeed, label)` down a path of stable labels, never from a shared
 * sequential stream. The failure mode that rules out a stream:
 *
 *     rng.next(); rng.next(); rng.next()
 *
 * inserting one planet shifts every value drawn afterwards, so adding a body to
 * a system silently rewrites its neighbours, and generating two regions in a
 * different order produces two different universes. Path derivation has neither
 * property — a region's seed depends only on its own address, so worker order,
 * traversal order and how much of the universe happens to be loaded are all
 * irrelevant.
 */

export interface Seed {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
}

/** Turn a human-facing seed string ("hello galaxy") into a root seed. */
export function rootSeed(text: string): Seed {
  const a = hashString(text, 0x9e37_79b9)
  const b = hashString(text, 0x85eb_ca6b)
  const c = hashString(text, 0xc2b2_ae35)
  const d = hashString(text, 0x27d4_eb2f)
  return normalizeSeed({ a, b, c, d })
}

export function seedFromNumber(value: number): Seed {
  return rootSeed(`n:${value}`)
}

/** xoshiro rejects the all-zero state; the odds are 2^-128 but the branch is free. */
function normalizeSeed(seed: Seed): Seed {
  if ((seed.a | seed.b | seed.c | seed.d) === 0)
    return { a: 1, b: 2, c: 3, d: 4 }
  return seed
}

/**
 * Derive a child seed from a parent and a stable label.
 *
 * Every lane absorbs every code unit, so sibling labels that differ in one
 * character ("body:3" vs "body:4") produce entirely unrelated seeds rather than
 * correlated ones — otherwise adjacent planets come out suspiciously similar.
 */
export function deriveSeed(parent: Seed, label: string): Seed {
  let a = (parent.a ^ 0x9e37_79b9) >>> 0
  let b = parent.b >>> 0
  let c = parent.c >>> 0
  let d = parent.d >>> 0
  for (let i = 0; i < label.length; i += 1) {
    const k = mix32((label.charCodeAt(i) ^ Math.imul(i + 1, 0x0100_0193)) | 0)
    a = mix32((a ^ k) | 0)
    b = (b + Math.imul(a, 0x85eb_ca6b)) >>> 0
    c = mix32((c ^ b) | 0)
    d = (d + Math.imul(c, 0xc2b2_ae35)) >>> 0
  }
  return normalizeSeed({
    a: mix32((a ^ d) | 0),
    b: mix32((b ^ a) | 0),
    c: mix32((c ^ b) | 0),
    d: mix32((d ^ c) | 0),
  })
}

/** Integer-labelled derivation, for hot paths like terrain region indices. */
export function deriveSeedInt(parent: Seed, value: number): Seed {
  return deriveSeed(parent, String(value | 0))
}

/** Walk a whole label path at once: `derivePath(root, ['system:sol', 'body:2'])`. */
export function derivePath(parent: Seed, labels: readonly string[]): Seed {
  let seed = parent
  for (const label of labels) seed = deriveSeed(seed, label)
  return seed
}

export const seedEquals = (a: Seed, b: Seed): boolean =>
  a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d

/** Stable hex form, for save files, logs and the debug overlay. */
export function formatSeed(seed: Seed): string {
  const hex = (n: number): string => n.toString(16).padStart(8, '0')
  return `${hex(seed.a)}${hex(seed.b)}${hex(seed.c)}${hex(seed.d)}`
}

export function parseSeed(text: string): Seed {
  invariant(/^[0-9a-f]{32}$/i.test(text), `Malformed seed: ${text}`)
  return {
    a: Number.parseInt(text.slice(0, 8), 16) >>> 0,
    b: Number.parseInt(text.slice(8, 16), 16) >>> 0,
    c: Number.parseInt(text.slice(16, 24), 16) >>> 0,
    d: Number.parseInt(text.slice(24, 32), 16) >>> 0,
  }
}
