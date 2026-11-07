'use no memo'
import { useState } from 'react'
import { Crosshair, Scan, X } from 'lucide-react'
import { formatAddress, walkBodies } from '@inertialref/universe'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { describeCause } from '../hud/notice.ts'
import type { PlanetariumContext } from './context.ts'

/**
 * What the eye is on, and the second body it may hold beside it.
 *
 * Two roles, named as two rows: the body the camera orbits or stands on, and
 * the target — a body in the same system the camera keeps in frame with it,
 * following the pair's plane as they move. "Target" is the observatory's own
 * word (`ir.target`); the name the camera *looks at* is the first row, and
 * calling the second one that too would put two subjects on one panel.
 *
 * The field is the Navigator's field — the same frame, the same mono step —
 * because a name typed here and a name typed there are one act at two scopes,
 * and a field in this panel that set its placeholder at the registry's 16px
 * clipped it to "Target a moon or |". The suggestions are the subject's own
 * system, which is the only place a target can be.
 */
export function TargetControls({ engine, onNotice }: PlanetariumContext) {
  const [query, setQuery] = useState('')
  const view = useEngine(
    useShallow((state) => ({
      anchor: state.observer?.target?.address,
      name: state.observer?.target?.name,
      system: state.observer?.target?.system,
      target: state.observer?.tracking?.name,
      standing: state.observer?.surface != null,
    })),
  )
  const system =
    view.system === undefined ? undefined : engine.world.system(view.system)
  const choices =
    system === undefined
      ? []
      : [
          { name: system.star.name, address: `g:milky-way/s:${system.id}` },
          ...[...walkBodies(system)].map((body) => ({
            name: body.name,
            address: formatAddress(body.address),
          })),
        ].filter((one) => one.address !== view.anchor)

  return (
    <div className="mb-1.5 flex flex-col gap-1.5 border-b border-slate-800 pb-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="type-ui shrink-0 text-slate-400">
          {view.standing ? 'Standing on' : 'Orbiting'}
        </span>
        <span className="type-ui truncate text-slate-200">
          {view.name ?? 'Nothing yet'}
        </span>
      </div>
      {!view.standing &&
        (view.target ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="type-ui shrink-0 text-slate-400">Target</span>
            <span className="type-ui flex min-w-0 flex-1 items-center gap-1.5 truncate text-sky-200">
              <Crosshair aria-hidden className="size-3.5 shrink-0" />
              {view.target}
            </span>
            <span className="flex gap-1">
              <Action
                label="Frame both"
                icon={Scan}
                title="Fit the pair inside the frame at this lens"
                onClick={() => engine.harness.observatory.framePair()}
              />
              <Action
                label="Clear"
                icon={X}
                title="Stop following the target; the camera stays where it is"
                onClick={() => engine.harness.target(null)}
              />
            </span>
          </div>
        ) : (
          <form
            className="flex items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                const address =
                  choices.find(
                    (one) => one.name.toLowerCase() === query.toLowerCase(),
                  )?.address ?? query
                engine.harness.target(address)
                setQuery('')
              } catch (cause) {
                onNotice(describeCause(cause))
              }
            }}
          >
            <label
              htmlFor="tracking-target"
              className="type-ui shrink-0 text-slate-400"
            >
              Target
            </label>
            <span className="flex min-w-0 flex-1 items-center rounded border border-slate-700/60 bg-slate-900/60 px-2 transition-colors focus-within:border-sky-500/60">
              <Input
                id="tracking-target"
                placeholder="a moon or planet here"
                list="tracking-bodies"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                // `md:type-readout` beside the bare step: the Input base
                // carries `md:text-sm`, which only merges against an equally
                // modified class. `lib/utils.ts` has the whole story.
                className="type-readout md:type-readout h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
            </span>
            <datalist id="tracking-bodies">
              {choices.map((one) => (
                <option key={one.address} value={one.name} />
              ))}
            </datalist>
            <Action
              label="Set"
              type="submit"
              title="Keep this body in frame beside the subject"
              disabled={!query.trim()}
            />
          </form>
        ))}
    </div>
  )
}
