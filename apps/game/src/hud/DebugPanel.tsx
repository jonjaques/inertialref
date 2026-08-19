import type { HarnessStatus } from '@inertialref/devtools'
import { formatDistance } from '@inertialref/shared'
import { CONTROL_HELP } from './useShipControls.ts'

/*
 * The debug overlay.
 *
 * Spec §20 asks for every invisible thing to be inspectable: entity id,
 * universe address, reference frame, local *and* canonical coordinates,
 * velocity, tick, seed, LOD, loaded region, authority and worker queue. They
 * are all here, because a coordinate system you cannot see is a coordinate
 * system you cannot debug.
 *
 * It reads a `HarnessStatus` — the same structure the scriptable harness
 * returns — so what a human sees and what an automated check asserts on cannot
 * drift apart.
 */

export function DebugPanel({ status, visible }: { status: HarnessStatus | null; visible: boolean }) {
  if (!visible || status === null) {
    return (
      <div className="pointer-events-none absolute right-3 top-3 rounded bg-slate-950/70 px-2 py-1 font-mono text-[11px] text-slate-400">
        Tab · panel
      </div>
    )
  }

  const { world, player, render, workers, frame } = status

  return (
    <div className="pointer-events-none absolute right-3 top-3 max-h-[calc(100vh-1.5rem)] w-96 overflow-auto rounded-lg border border-slate-700/60 bg-slate-950/80 p-3 font-mono text-[11px] leading-relaxed text-slate-300 shadow-xl backdrop-blur">
      <Section title="simulation">
        <Row label="seed" value={`${world.seed} · ${world.seedHex.slice(0, 12)}…`} />
        <Row label="tick" value={`${world.tick} · ${world.timeText}`} />
        <Row
          label="clock"
          value={`${world.timeScale}× ${world.paused ? '· paused' : ''}${world.droppedTicks > 0 ? ` · ${world.droppedTicks} dropped` : ''}`}
        />
        <Row label="state hash" value={world.stateHash} />
        <Row
          label="frame"
          value={frame === null ? '—' : `${frame.fps.toFixed(0)} fps · ${frame.frameMs.toFixed(2)} ms · ${frame.ticksLastFrame} ticks`}
        />
      </Section>

      {player !== null && (
        <Section title="player">
          <Row label="entity" value={`${player.id} · ${player.name}`} />
          <Row label="address" value={player.address ?? '(dynamic)'} />
          <Row label="frame" value={player.frame} />
          <Row label="chain" value={player.frameChain.join(' › ')} wrap />
          <Row label="authority" value={player.partition} />
          <Row label="canonical" value={player.canonical.text} wrap />
          <Row
            label="local"
            value={`${player.local.x.toFixed(2)}, ${player.local.y.toFixed(2)}, ${player.local.z.toFixed(2)} m`}
          />
          <Row label="speed" value={`${player.localSpeedText} local · ${player.speedText} universe`} />
          <Row label="altitude" value={player.altitudeText ?? '—'} />
          <Row label="state" value={player.landed ? 'landed' : 'flying'} />
        </Section>
      )}

      {render !== null && (
        <Section title="render">
          <Row label="origin sector" value={render.originSector.join(', ')} />
          <Row label="rebases" value={String(render.originGeneration)} />
          <Row label="anchor" value={render.anchorFrame} />
          <Row
            label="camera"
            value={render.cameraRenderPosition.map((n) => n.toFixed(1)).join(', ')}
          />
          <Row label="stars" value={String(render.starCount)} />
          <Row label="streaming" value={render.terrainCandidates.join(', ') || '—'} wrap />
          <div className="mt-1 border-t border-slate-800 pt-1">
            {render.bodies.slice(0, 6).map((body) => (
              <div key={body.name} className="flex justify-between gap-2">
                <span className="truncate text-slate-400">{body.name}</span>
                <span className="shrink-0 text-slate-500">
                  {body.tier}
                  {body.compressed ? '*' : ''} · {body.distanceText}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="universe">
        <Row label="systems" value={world.loadedSystems.map((s) => `${s.name} (${s.bodies})`).join(', ')} wrap />
        <Row label="frames" value={String(world.frames)} />
        <Row label="entities" value={String(world.entityCount)} />
        <Row
          label="workers"
          value={
            workers === null
              ? 'inline'
              : `${workers.workers}w · ${workers.active} active · ${workers.queued} queued · ${workers.completed} done · q ${workers.averageQueueMs.toFixed(1)}ms · run ${workers.averageRunMs.toFixed(1)}ms`
          }
          wrap
        />
      </Section>

      {world.events.length > 0 && (
        <Section title="events">
          {world.events.slice(-5).map((event, index) => (
            <div key={`${event.tick}-${index}`} className="truncate text-slate-400">
              <span className="text-slate-600">{event.tick}</span> {event.kind} · {event.detail}
            </div>
          ))}
        </Section>
      )}

      <Section title="controls">
        <div className="grid grid-cols-[5.5rem_1fr] gap-x-2">
          {CONTROL_HELP.map(([key, description]) => (
            <div key={key} className="contents">
              <span className="text-slate-500">{key}</span>
              <span className="text-slate-400">{description}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-slate-500">
          console: <span className="text-sky-300">ir.help()</span> ·{' '}
          <span className="text-sky-300">await ir.selfTest()</span>
        </div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-[10px] uppercase tracking-widest text-sky-400/80">{title}</div>
      {children}
    </div>
  )
}

function Row({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={wrap ? 'break-all text-right text-slate-300' : 'truncate text-right text-slate-300'}>
        {value}
      </span>
    </div>
  )
}

/** Compact flight readout, bottom left, for when the panel is hidden. */
export function FlightStrip({ status }: { status: HarnessStatus | null }) {
  if (status === null || status.player === null) return null
  const { player, world } = status
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-slate-700/60 bg-slate-950/75 px-3 py-2 font-mono text-xs text-slate-200 backdrop-blur">
      <div className="text-sky-300">{player.name}</div>
      <div>{player.localSpeedText} relative to frame</div>
      <div className="text-slate-400">
        {player.altitude === null ? player.frame : `alt ${formatDistance(player.altitude)}`}
      </div>
      <div className="text-slate-500">
        tick {world.tick} · {world.timeScale}×{world.paused ? ' · paused' : ''}
      </div>
    </div>
  )
}
