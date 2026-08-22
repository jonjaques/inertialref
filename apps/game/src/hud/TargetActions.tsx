import type { TravelTarget } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from './Action.tsx'

/**
 * Where `land` puts you when nobody says otherwise.
 *
 * The same site the `surface` scenario uses, so what the button does and what
 * `pnpm sim --scenario surface` does are the same landing, on purpose: a
 * discrepancy between them would be invisible and would waste an afternoon.
 */
const DEBUG_LANDING_SITE = { latitude: 0.35, longitude: -1.1 }

/**
 * What you can do with the selected destination.
 *
 * A system and a body have disjoint verbs, and that is the whole shape of this
 * component: you cannot land on a star system and "generate" means nothing for
 * a planet whose system is already resolved. Every one of them is a harness
 * call, so anything clicked here is reproducible from the console and from a
 * headless test — which is the rule `NavPanel` exists under.
 */
export function TargetActions({
  engine,
  target,
  run,
}: {
  engine: GameEngine
  target: TravelTarget
  /** The panel's own try/catch-and-report. See `NavPanel`. */
  run: (label: string, action: () => void) => void
}) {
  if (target.kind === 'system')
    return (
      <>
        <Action
          label="travel"
          tone="primary"
          title="Orbit this system's star, looking at it"
          onClick={() =>
            run(`travelling to ${target.name}`, () =>
              engine.harness.goTo(target.address),
            )
          }
        />
        <Action
          label="generate"
          disabled={target.loaded}
          title="Generate the system and list its bodies without going there"
          onClick={() =>
            run(`generated ${target.name}`, () => {
              engine.harness.loadSystem(target.system)
            })
          }
        />
      </>
    )

  return (
    <>
      <Action
        label="orbit"
        tone="primary"
        title="Circular orbit at an altitude that frames the body"
        onClick={() =>
          run(`orbiting ${target.name}`, () =>
            engine.harness.goTo(target.address),
          )
        }
      />
      <Action
        label="land"
        disabled={!target.landable}
        title={target.landable ? 'Park on the surface' : 'Not solid ground'}
        onClick={() =>
          run(`landing on ${target.name}`, () =>
            engine.harness.land(
              target.address,
              DEBUG_LANDING_SITE.latitude,
              DEBUG_LANDING_SITE.longitude,
            ),
          )
        }
      />
      <Action
        label="face"
        title="Point the nose at it without touching the trajectory"
        onClick={() =>
          run(`facing ${target.name}`, () =>
            engine.harness.face(target.address),
          )
        }
      />
      <Action
        label="burn"
        title="Aim at it and light the main drive"
        onClick={() =>
          run(`burning toward ${target.name}`, () =>
            engine.harness.burnToward(target.address),
          )
        }
      />
    </>
  )
}
