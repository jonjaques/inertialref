import type { StarField } from '../engine/starSelection.ts'
import type { StarfieldMaterial } from './materials.ts'

export type NamedStars = Map<string, number | number[]>

/** Selection changes touch the active dirty span, preserving retained colors and names. */
export function uploadStarfieldAppearance(
  material: Pick<StarfieldMaterial, 'colours' | 'enabled'>,
  stars: StarField,
  previous: StarField | null,
  names: NamedStars,
  hidden: Set<number>,
  count: number,
): void {
  const colours = material.colours.array as Float32Array
  let first = count
  let last = -1
  const oldCount = Math.min(
    previous?.positions.length ?? 0,
    material.enabled.count,
  )
  const span = Math.max(count, oldCount)
  let renamed = 0
  for (let i = 0; i < span; i++)
    if (
      (previous?.names[i] ?? '') !== (i < count ? (stars.names[i] ?? '') : '')
    )
      renamed++
  // A broad reorder otherwise creates temporary duplicate-name arrays while
  // moving every index through the old map. Rebuild once when most slots move.
  const remap = renamed > span / 2
  if (remap) names.clear()
  for (let i = 0; i < (remap ? count : span); i++) {
    const oldName = remap ? '' : (previous?.names[i] ?? '')
    const name = i < count ? (stars.names[i] ?? '') : ''
    if (oldName !== name) {
      if (oldName !== '') {
        const indices = names.get(oldName)
        if (typeof indices === 'number') names.delete(oldName)
        else if (indices !== undefined) {
          const at = indices.indexOf(i)
          if (at !== -1) indices.splice(at, 1)
          if (indices.length === 1) names.set(oldName, indices[0]!)
        }
      }
      if (name !== '') {
        const indices = names.get(name)
        if (indices === undefined) names.set(name, i)
        else if (typeof indices === 'number') names.set(name, [indices, i])
        else indices.push(i)
      }
    }
    if (i >= count) continue
    const colour = stars.colours[i]
    const before = previous?.colours[i]
    if (
      i < oldCount &&
      (colour === before ||
        (colour !== undefined &&
          before !== undefined &&
          colour[0] === before[0] &&
          colour[1] === before[1] &&
          colour[2] === before[2]))
    )
      continue
    const red = colour?.[0] ?? 1
    const green = colour?.[1] ?? 1
    const blue = colour?.[2] ?? 1
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
    const normalization = luminance > 0 ? 1 / luminance : 0
    colours[i * 3] = red * normalization
    colours[i * 3 + 1] = green * normalization
    colours[i * 3 + 2] = blue * normalization
    first = Math.min(first, i)
    last = i
  }
  if (first <= last) {
    material.colours.addUpdateRange(first * 3, (last - first + 1) * 3)
    material.colours.needsUpdate = true
  }
  // Only resolved disks can have disabled an instance. Reset those few slots;
  // filling the entire capacity both walks and uploads stars nobody selected.
  for (const index of hidden) {
    material.enabled.array[index] = 1
    material.enabled.addUpdateRange(index, 1)
  }
  if (hidden.size > 0) material.enabled.needsUpdate = true
  hidden.clear()
}
