import { type ComponentType, use } from 'react'
import type { TrackedPromise } from './modeLoader.ts'

/**
 * A mode whose code arrives on demand, rendered the moment it is in hand.
 *
 * `use` on the loader's tracked promise: a chunk that has landed renders in
 * this same pass, and one still on its way suspends to the boundary above.
 * `React.lazy` cannot make that distinction — it suspends once for every
 * chunk, landed or not — and `pages/modeLoader.ts` says what that one
 * suspension cost. The promise is cached by the loader, so `use` never sees
 * a fresh one per render.
 */
export function LoadedMode<Props extends object>({
  load,
  props,
}: {
  readonly load: () => TrackedPromise<{ default: ComponentType<Props> }>
  readonly props: Props
}) {
  const { default: Mode } = use(load())
  return <Mode {...props} />
}
