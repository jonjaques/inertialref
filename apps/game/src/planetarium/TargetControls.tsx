'use no memo'
import { useState } from 'react'
import { Crosshair, Scan, X } from 'lucide-react'
import { formatAddress, walkBodies } from '@inertialref/universe'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { describeCause } from '../hud/notice.ts'
import type { PlanetariumContext } from './context.ts'

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
    <div className="mb-2 flex flex-col gap-2">
      <div className="type-ui flex items-center justify-between gap-2 text-slate-400">
        <span>{view.standing ? 'Standing on' : 'Orbiting'}</span>
        <span className="truncate text-slate-200">
          {view.name ?? 'No body'}
        </span>
      </div>
      {!view.standing && (
        <>
          {view.target ? (
            <div className="flex items-center gap-2">
              <Crosshair aria-hidden className="size-3.5 text-sky-400" />
              <span className="type-ui min-w-0 flex-1 truncate text-sky-200">
                Target: {view.target}
              </span>
              <TransportButton
                label="Frame both bodies"
                icon={Scan}
                onClick={() => engine.harness.observatory.framePair()}
              />
              <TransportButton
                label="Clear target"
                icon={X}
                onClick={() => engine.harness.target(null)}
              />
            </div>
          ) : (
            <form
              className="flex gap-1"
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
              <Input
                aria-label="Target body"
                placeholder="Target a moon or planet"
                list="tracking-bodies"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <datalist id="tracking-bodies">
                {choices.map((one) => (
                  <option key={one.address} value={one.name} />
                ))}
              </datalist>
              <Action
                label="Target"
                icon={Crosshair}
                type="submit"
                disabled={!query.trim()}
              />
            </form>
          )}
        </>
      )}
    </div>
  )
}
