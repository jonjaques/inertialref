import { Sparkles } from 'lucide-react'
import { CONTROL_HELP } from '../hud/useShipControls.ts'

/**
 * The bindings as they actually are, read from the one table that defines
 * them. `docs/design/ux.md` requires everything to be rebindable; until that
 * exists, a reference beats a promise.
 */
export function ControlsSection() {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {CONTROL_HELP.map(([keys, what]) => (
          <div key={keys} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-sky-300/80 tabular-nums">{keys}</dt>
            <dd className="text-slate-400">{what}</dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-slate-800 pt-2">
        <h3 className="type-label mb-1 flex items-center gap-1.5 text-sky-400/80">
          <Sparkles aria-hidden className="size-3" />
          Planetarium
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {PLANETARIUM_HELP.map(([keys, what]) => (
            <div key={keys} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-sky-300/80 tabular-nums">{keys}</dt>
              <dd className="text-slate-400">{what}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="text-slate-400">
        Rebinding is designed and not built — see{' '}
        <span className="text-slate-400">docs/design/ux.md</span>.
      </p>
    </div>
  )
}

/**
 * The planetarium's own bindings.
 *
 * Here rather than beside `gestures.ts` because this is the *documentation* of
 * a mapping, and the mapping is a table in `keyAction`. Two lists that could
 * drift is a real risk and the alternative — deriving prose from a switch — is
 * worse; what stops the drift is that `gestures.test.ts` asserts each of these
 * behaviors by name.
 */
const PLANETARIUM_HELP: readonly (readonly [string, string])[] = [
  ['drag', 'orbit the target'],
  ['wheel / pinch', 'zoom, logarithmically'],
  ['click', 'focus whatever is under the pointer'],
  ['↑ ↓ ← →', 'orbit — hold shift for coarse'],
  ['+ / −', 'zoom in / out'],
  ['F', 'frame the target'],
  ['Home', 'back to Earth'],
]
