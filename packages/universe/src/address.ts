import { type Brand, invariant } from '@inertialref/shared'

/*
 * Universe addressing (ADR-0004).
 *
 * An address is a path through the containment hierarchy, written as
 * slash-separated typed segments:
 *
 *   g:milky-way
 *   g:milky-way/s:HIP71683
 *   g:milky-way/s:HIP71683/b:2         third planet
 *   g:milky-way/s:HIP71683/b:2.0       its first moon
 *   g:milky-way/s:HIP71683/b:2/r:3.6.12.44    a surface region
 *   g:milky-way/s:HIP71683/b:2/r:3.6.12.44/o:7  a generated object in it
 *
 * The properties that matter, in order of how expensive they are to retrofit:
 *
 *   - It is derived from *containment*, never from array order, insertion
 *     order, memory, Three.js object ids, worker scheduling or connection
 *     order. Regenerating the universe from the seed reproduces every address.
 *   - It exists whether or not the thing is loaded. "Where is the third planet
 *     of HIP71683" is answerable without having generated it.
 *   - It is the seed path. Generation, persistence, save files, logs, the debug
 *     overlay and the harness all key off the same string, so a bug report can
 *     be replayed by pasting one address.
 *   - It survives a round trip through text, which is what makes it usable in
 *     a URL, a save file and a network message alike.
 */

export type GalaxyId = Brand<string, 'galaxy'>
export type SystemId = Brand<string, 'system'>

/** Ids appear in text addresses, so the character set has to stay unambiguous. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function galaxyId(id: string): GalaxyId {
  invariant(ID_PATTERN.test(id), `Malformed galaxy id: ${id}`)
  return id as GalaxyId
}

export function systemId(id: string): SystemId {
  invariant(ID_PATTERN.test(id), `Malformed system id: ${id}`)
  return id as SystemId
}

/**
 * Total counterpart to `systemId`, for parsing text that may not be one.
 *
 * `systemId` throws, which is right when a malformed id is a programming error
 * and wrong when the string came from a frame id, a URL or the network and
 * "not a system" is an ordinary answer.
 */
export const isSystemId = (text: string): text is SystemId =>
  ID_PATTERN.test(text)

/**
 * The deepest subdivision an address can carry.
 *
 * Twenty-four halvings of a cube face take an Earth-sized body from 10,000 km
 * to 60 cm, which is the smallest ground a region has ever needed to name. It
 * is a property of the address space rather than of the renderer: what the
 * streamer will actually ask for is `surfaceDetailFloor`, which is a property
 * of the field.
 */
export const MAX_REGION_LEVEL = 24

/**
 * A cube-sphere surface region: which face, how deep the subdivision, and where
 * on that face's grid. Level n has 2^n cells per side.
 */
export interface RegionAddress {
  readonly face: number
  readonly level: number
  readonly i: number
  readonly j: number
}

export function regionAddress(
  face: number,
  level: number,
  i: number,
  j: number,
): RegionAddress {
  invariant(
    Number.isInteger(face) && face >= 0 && face < 6,
    `Bad cube face ${face}`,
  )
  invariant(
    Number.isInteger(level) && level >= 0 && level <= MAX_REGION_LEVEL,
    `Bad region level ${level}`,
  )
  const span = 2 ** level
  invariant(
    Number.isInteger(i) && i >= 0 && i < span,
    `Region i out of range: ${i}`,
  )
  invariant(
    Number.isInteger(j) && j >= 0 && j < span,
    `Region j out of range: ${j}`,
  )
  return { face, level, i, j }
}

export type UniverseAddress =
  | { readonly kind: 'galaxy'; readonly galaxy: GalaxyId }
  | {
      readonly kind: 'system'
      readonly galaxy: GalaxyId
      readonly system: SystemId
    }
  | {
      readonly kind: 'body'
      readonly galaxy: GalaxyId
      readonly system: SystemId
      /** Orbital index path: [2] is the third planet, [2, 0] its first moon. */
      readonly body: readonly number[]
    }
  | {
      readonly kind: 'region'
      readonly galaxy: GalaxyId
      readonly system: SystemId
      readonly body: readonly number[]
      readonly region: RegionAddress
    }
  | {
      readonly kind: 'object'
      readonly galaxy: GalaxyId
      readonly system: SystemId
      readonly body: readonly number[]
      readonly region: RegionAddress
      readonly index: number
    }

export const galaxyAddress = (galaxy: GalaxyId): UniverseAddress => ({
  kind: 'galaxy',
  galaxy,
})

export const systemAddress = (
  galaxy: GalaxyId,
  system: SystemId,
): UniverseAddress => ({
  kind: 'system',
  galaxy,
  system,
})

export function bodyAddress(
  galaxy: GalaxyId,
  system: SystemId,
  body: readonly number[],
): UniverseAddress {
  invariant(body.length > 0, 'A body address needs at least one orbital index')
  invariant(
    body.every((i) => Number.isInteger(i) && i >= 0 && i < 4096),
    `Bad orbital index path: ${body.join('.')}`,
  )
  return { kind: 'body', galaxy, system, body }
}

export const regionOf = (
  body: UniverseAddress,
  region: RegionAddress,
): UniverseAddress => {
  invariant(body.kind === 'body', 'Regions belong to bodies')
  return {
    kind: 'region',
    galaxy: body.galaxy,
    system: body.system,
    body: body.body,
    region,
  }
}

export const objectOf = (
  region: UniverseAddress,
  index: number,
): UniverseAddress => {
  invariant(region.kind === 'region', 'Objects belong to regions')
  invariant(Number.isInteger(index) && index >= 0, `Bad object index ${index}`)
  return {
    kind: 'object',
    galaxy: region.galaxy,
    system: region.system,
    body: region.body,
    region: region.region,
    index,
  }
}

/* ------------------------------------------------------------------------- */
/* Text form                                                                  */
/* ------------------------------------------------------------------------- */

const formatRegion = (r: RegionAddress): string =>
  `${r.face}.${r.level}.${r.i}.${r.j}`

export function formatAddress(address: UniverseAddress): string {
  const parts = [`g:${address.galaxy}`]
  if (address.kind === 'galaxy') return parts.join('/')
  parts.push(`s:${address.system}`)
  if (address.kind === 'system') return parts.join('/')
  parts.push(`b:${address.body.join('.')}`)
  if (address.kind === 'body') return parts.join('/')
  parts.push(`r:${formatRegion(address.region)}`)
  if (address.kind === 'region') return parts.join('/')
  parts.push(`o:${address.index}`)
  return parts.join('/')
}

const INTEGER_PATTERN = /^\d+$/

function parseIntegerList(text: string, what: string): number[] {
  const parts = text.split('.')
  invariant(parts.length > 0, `Empty ${what}`)
  return parts.map((part) => {
    invariant(INTEGER_PATTERN.test(part), `Bad ${what}: ${text}`)
    return Number.parseInt(part, 10)
  })
}

/**
 * Parse a text address.
 *
 * Throws rather than returning a Result: addresses come from generation, save
 * files and the harness, and a malformed one is a bug at the producer, not a
 * condition a caller can meaningfully recover from. The protocol package
 * validates untrusted input before it reaches here.
 */
export function parseAddress(text: string): UniverseAddress {
  const segments = text.split('/')
  let galaxy: GalaxyId | null = null
  let system: SystemId | null = null
  let body: number[] | null = null
  let region: RegionAddress | null = null
  let index: number | null = null

  for (const segment of segments) {
    const colon = segment.indexOf(':')
    invariant(colon > 0, `Malformed address segment: ${segment}`)
    const tag = segment.slice(0, colon)
    const value = segment.slice(colon + 1)
    switch (tag) {
      case 'g':
        galaxy = galaxyId(value)
        break
      case 's':
        system = systemId(value)
        break
      case 'b':
        body = parseIntegerList(value, 'orbital index path')
        break
      case 'r': {
        const parts = parseIntegerList(value, 'region address')
        invariant(
          parts.length === 4,
          `Region address needs face.level.i.j, got ${value}`,
        )
        region = regionAddress(
          parts[0] as number,
          parts[1] as number,
          parts[2] as number,
          parts[3] as number,
        )
        break
      }
      case 'o':
        invariant(INTEGER_PATTERN.test(value), `Bad object index ${value}`)
        index = Number.parseInt(value, 10)
        break
      default:
        invariant(false, `Unknown address segment tag "${tag}" in ${text}`)
    }
  }

  invariant(galaxy !== null, `Address must start with a galaxy: ${text}`)
  if (system === null) return { kind: 'galaxy', galaxy }
  if (body === null) return { kind: 'system', galaxy, system }
  if (region === null) return bodyAddress(galaxy, system, body)
  if (index === null) return { kind: 'region', galaxy, system, body, region }
  return { kind: 'object', galaxy, system, body, region, index }
}

/* ------------------------------------------------------------------------- */
/* Derived views                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Label path for seed derivation.
 *
 * Each body index is its own label so a moon's seed descends from its planet's
 * — the containment hierarchy and the seed hierarchy are the same tree, which
 * is what lets a moon be generated without generating its siblings.
 */
export function addressLabels(address: UniverseAddress): readonly string[] {
  const labels: string[] = [`g:${address.galaxy}`]
  if (address.kind === 'galaxy') return labels
  labels.push(`s:${address.system}`)
  if (address.kind === 'system') return labels
  for (const index of address.body) labels.push(`b:${index}`)
  if (address.kind === 'body') return labels
  labels.push(`r:${formatRegion(address.region)}`)
  if (address.kind === 'region') return labels
  labels.push(`o:${address.index}`)
  return labels
}

/** The containing address one level up, or null at the galaxy. */
export function parentAddress(
  address: UniverseAddress,
): UniverseAddress | null {
  switch (address.kind) {
    case 'galaxy':
      return null
    case 'system':
      return { kind: 'galaxy', galaxy: address.galaxy }
    case 'body':
      return address.body.length === 1
        ? { kind: 'system', galaxy: address.galaxy, system: address.system }
        : bodyAddress(address.galaxy, address.system, address.body.slice(0, -1))
    case 'region':
      return bodyAddress(address.galaxy, address.system, address.body)
    case 'object':
      return {
        kind: 'region',
        galaxy: address.galaxy,
        system: address.system,
        body: address.body,
        region: address.region,
      }
  }
}

export const addressEquals = (
  a: UniverseAddress,
  b: UniverseAddress,
): boolean => formatAddress(a) === formatAddress(b)

/** The system an address lives in, if any. Interest management keys off this. */
export function systemOf(address: UniverseAddress): SystemId | null {
  return address.kind === 'galaxy' ? null : address.system
}

/* ------------------------------------------------------------------------- */
/* Entity identity                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Runtime identity of a simulated thing.
 *
 * Two flavours, deliberately distinguishable at a glance:
 *
 *   `@g:milky-way/s:SOL/b:2`  — a generated entity, identity is its address
 *   `#7`                      — a dynamic entity (player ship, spawned object)
 *
 * Dynamic ids come from a counter that lives in the save file rather than from
 * a UUID: a random id would make two replays of the same session disagree, and
 * the counter is exactly as unique while staying deterministic.
 */
export type EntityId = Brand<string, 'entity'>

export const entityIdForAddress = (address: UniverseAddress): EntityId =>
  `@${formatAddress(address)}` as EntityId

export const dynamicEntityId = (counter: number): EntityId => {
  invariant(
    Number.isInteger(counter) && counter >= 0,
    `Bad dynamic entity counter ${counter}`,
  )
  return `#${counter}` as EntityId
}

export const isDynamicEntity = (id: EntityId): boolean => id.startsWith('#')

/** The address an entity id was minted from, or null for dynamic entities. */
export function addressOfEntity(id: EntityId): UniverseAddress | null {
  return id.startsWith('@') ? parseAddress(id.slice(1)) : null
}
