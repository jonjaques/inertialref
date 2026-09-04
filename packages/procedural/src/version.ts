/*
 * Generation algorithm versions.
 *
 * A version is a **declaration**, not an input. Nothing here reaches a seed
 * path: the number says which generator wrote a world, and the generator that
 * moved is what makes the world different. Folding it into the seed instead
 * would move every body in the galaxy on every bump, including the ones the
 * change did not touch — which is the opposite of what a version is for, since
 * the loader could then no longer tell "this save's ground moved" from
 * "everything moved".
 *
 * So the bump is the honest half of a change that already happened, and it has
 * to be spent by hand. A save records the versions it was generated with (see
 * the persistence package) and `ClientHello` carries them, which is what makes
 * "this save was made with terrain v2" a statement the loader can act on
 * instead of a mystery.
 */
export interface AlgorithmVersion {
  readonly name: string
  readonly version: number
}

export const algorithm = (name: string, version: number): AlgorithmVersion => ({
  name,
  version,
})

export const versionLabel = (v: AlgorithmVersion): string =>
  `${v.name}@${v.version}`

export type VersionManifest = Readonly<Record<string, number>>

export function manifest(
  versions: readonly AlgorithmVersion[],
): VersionManifest {
  const out: Record<string, number> = {}
  for (const v of versions) out[v.name] = v.version
  return out
}
