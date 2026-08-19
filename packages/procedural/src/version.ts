/*
 * Generation algorithm versions.
 *
 * The version is folded into the seed path, so bumping it deliberately produces
 * a different universe rather than silently mutating saved worlds under the
 * player. A save records the versions it was generated with (see the
 * persistence package), which is what makes "this save was made with terrain v2"
 * a statement the loader can act on instead of a mystery.
 */
export interface AlgorithmVersion {
  readonly name: string
  readonly version: number
}

export const algorithm = (name: string, version: number): AlgorithmVersion => ({ name, version })

export const versionLabel = (v: AlgorithmVersion): string => `${v.name}@${v.version}`

export type VersionManifest = Readonly<Record<string, number>>

export function manifest(versions: readonly AlgorithmVersion[]): VersionManifest {
  const out: Record<string, number> = {}
  for (const v of versions) out[v.name] = v.version
  return out
}
