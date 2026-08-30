import type { GameEngine } from '../engine/GameEngine.ts'
import type { Connection } from '../net/health.ts'
import type {
  CameraState,
  GraphicsState,
  HudCommands,
  HudRenderState,
} from './controls.ts'

/**
 * Everything the author's instruments read, in one shape.
 *
 * The same arrangement `planetarium/context.ts` uses, and for the same reason:
 * a panel body is a thunk that closes over this, so a definition needs no props
 * type of its own and a closed panel costs nothing. `App` is the only thing
 * that can assemble it — the renderer description, the connection monitor and
 * the command table all live there — which is also why the dev group is passed
 * down to the modes rather than composed inside one.
 *
 * No `status` field, and its absence is load-bearing. A `HarnessStatus` is a
 * fresh object graph every sample, so carrying it here meant `App` had to
 * subscribe to it, and `App` re-rendering is the whole interface re-rendering
 * at the sample rate. The panels that display live figures subscribe to
 * `state/engineStore.ts` themselves, at the same 8 Hz, alone.
 */
export interface DevContext {
  readonly engine: GameEngine
  readonly render: HudRenderState
  readonly graphics: GraphicsState
  readonly camera: CameraState
  readonly connection: Connection
  readonly onCheckConnection: () => void
  readonly commands: HudCommands
  readonly onNotice: (message: string) => void
}
