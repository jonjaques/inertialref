import type { Connection } from '../net/health.ts'
import { useEngine } from '../state/engineStore.ts'
import { describeOutput, type RendererDescription } from '../render/output.ts'
import { AuthoritySection } from './AuthoritySection.tsx'
import { NetworkSection } from './NetworkSection.tsx'
import { Row } from './Row.tsx'
import { KeySheet } from '../input/KeySheet.tsx'
import { Section } from './Section.tsx'

/*
 * The debug readout.
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
 *
 * Every group collapses and remembers it. Twelve inspectable fields is the
 * right number to *have* and the wrong number to read at once while flying;
 * before the dock existed this panel was 40 lines tall and permanently in the
 * way of the thing it was reporting on.
 */

/**
 * Join a list without letting it become the panel.
 *
 * These rows are unbounded by construction — `loadedSystems` grows with every
 * system generated in a session and `terrainCandidates` with the streamer's
 * appetite — and a `wrap` row has no ceiling, so ten minutes of flying turned
 * the universe section into a paragraph and pushed everything below it out of
 * reach. The overflow is *stated* rather than dropped: a list silently cut at
 * eight reads as a list of eight, which is the one thing a debug readout may
 * not do.
 */
const CAPPED_ITEMS = 8

function summarise(items: readonly string[]): string {
  if (items.length === 0) return '—'
  if (items.length <= CAPPED_ITEMS) return items.join(', ')
  return `${items.slice(0, CAPPED_ITEMS).join(', ')} · +${items.length - CAPPED_ITEMS} more`
}

export function TelemetryPanel({
  output,
  connection,
  onCheckConnection,
}: {
  output: RendererDescription | null
  connection: Connection
  onCheckConnection: () => void
}) {
  // The whole status, deliberately: this panel's job is to show most of it, so
  // re-rendering at the full sample rate is correct — and subscribing here is
  // what keeps that rate the panel's own rather than the interface's.
  const status = useEngine((snapshot) => snapshot.status)
  // The network section does not wait for the first frame, because the two are
  // unrelated: a session that never reaches a server still flies, and a session
  // still building its first frame may already know it cannot reach one.
  const network = (
    <>
      <AuthoritySection authority={status?.authority ?? null} />
      <NetworkSection connection={connection} onCheck={onCheckConnection} />
    </>
  )
  if (status === null)
    return (
      <div>
        <div className="mb-2 text-slate-400">waiting for the first frame…</div>
        {network}
      </div>
    )
  const { world, player, render, workers, frame } = status

  return (
    <div>
      <Section
        id="tel.simulation"
        title="Simulation"
        trailing={`tick ${world.tick}`}
      >
        <Row
          label="Seed"
          value={`${world.seed} · ${world.seedHex.slice(0, 12)}…`}
        />
        <Row label="Tick" value={`${world.tick} · ${world.timeText}`} />
        <Row
          label="Clock"
          value={`${world.timeScale}× ${world.paused ? '· paused' : ''}${world.droppedTicks > 0 ? ` · ${world.droppedTicks} dropped` : ''}`}
        />
        <Row label="State Hash" value={world.stateHash} />
        <Row
          label="Frame"
          value={
            frame === null
              ? '—'
              : `${frame.fps.toFixed(0)} fps · ${frame.frameMs.toFixed(2)} ms · ${frame.ticksLastFrame} ticks`
          }
        />
      </Section>

      {player !== null && (
        <Section
          id="tel.player"
          title="Player"
          trailing={player.landed ? 'landed' : 'flying'}
        >
          <Row label="Entity" value={`${player.id} · ${player.name}`} />
          <Row label="Address" value={player.address ?? '(dynamic)'} />
          <Row label="Frame" value={player.frame} />
          <Row label="Chain" value={player.frameChain.join(' › ')} wrap />
          <Row label="Authority" value={player.partition} />
          <Row label="Canonical" value={player.canonical.text} wrap />
          <Row
            label="Local"
            value={`${player.local.x.toFixed(2)}, ${player.local.y.toFixed(2)}, ${player.local.z.toFixed(2)} m`}
          />
          <Row
            label="Speed"
            value={`${player.localSpeedText} local · ${player.speedText} universe`}
          />
          <Row label="Altitude" value={player.altitudeText ?? '—'} />
          <Row label="State" value={player.landed ? 'landed' : 'flying'} />
        </Section>
      )}

      {/*
       * The three HDR signals, separately, because they routinely disagree and
       * the interesting cases are the disagreements. Spike 1 measured one
       * physical display reporting `dynamic-range: high` as true, true and
       * false across three browsers — so a single "HDR: on" line would be a
       * claim this page is not in a position to make.
       */}
      {output !== null && (
        <Section id="tel.output" title="Output" trailing={output.mode}>
          <Row label="Pipeline" value={describeOutput(output)} />
          <Row label="Backend" value={output.backend} />
          <Row
            label="Range"
            value={
              output.mode === 'extended'
                ? `extended · ${output.headroom}× headroom`
                : 'sRGB · clamped at white'
            }
          />
          <Row label="Preference" value={output.preference} />
          <Row
            label="navigator.gpu"
            value={output.capability.webgpu ? 'present' : 'absent'}
          />
          <Row
            label="dynamic-range: high"
            value={String(output.capability.dynamicRangeHigh)}
          />
          <Row
            // `rgba16float` stays verbatim like `navigator.gpu` above — it is
            // the literal GPUTextureFormat token, and title-casing it makes a
            // string that matches nothing in any WebGPU document.
            label="rgba16float Canvas"
            value={output.capability.extendedCanvas ? 'configured' : 'refused'}
          />
        </Section>
      )}

      {render !== null && (
        <Section
          id="tel.render"
          title="Render"
          trailing={`${render.starCount} stars`}
        >
          <Row label="Origin Sector" value={render.originSector.join(', ')} />
          <Row label="Rebases" value={String(render.originGeneration)} />
          <Row label="Anchor" value={render.anchorFrame} />
          <Row
            label="Camera"
            value={render.cameraRenderPosition
              .map((n) => n.toFixed(1))
              .join(', ')}
          />
          <Row label="Stars" value={String(render.starCount)} />
          <Row
            label="Streaming"
            value={summarise(render.terrainCandidates)}
            wrap
          />
          <div className="mt-1 border-t border-slate-800 pt-1">
            {render.bodies.slice(0, 6).map((body) => (
              <div key={body.name} className="flex justify-between gap-2">
                <span className="truncate text-slate-400" title={body.name}>
                  {body.name}
                </span>
                <span className="shrink-0 text-slate-400">
                  {body.tier}
                  {body.compressed ? '*' : ''} · {body.distanceText}
                </span>
              </div>
            ))}
            {render.bodies.length > 6 && (
              <div className="text-slate-400">
                +{render.bodies.length - 6} more · ir.status().render.bodies
              </div>
            )}
          </div>
        </Section>
      )}

      <Section
        id="tel.universe"
        title="Universe"
        trailing={`${world.loadedSystems.length} systems`}
      >
        <Row
          label="Systems"
          value={summarise(
            world.loadedSystems.map((s) => `${s.name} (${s.bodies})`),
          )}
          wrap
        />
        <Row label="Frames" value={String(world.frames)} />
        <Row label="Entities" value={String(world.entityCount)} />
        <Row
          label="Workers"
          value={
            workers === null
              ? 'inline'
              : `${workers.workers}w · ${workers.active} active · ${workers.queued} queued · ${workers.completed} done · q ${workers.averageQueueMs.toFixed(1)}ms · run ${workers.averageRunMs.toFixed(1)}ms`
          }
          wrap
        />
      </Section>

      {world.events.length > 0 && (
        <Section
          id="tel.events"
          title="Events"
          trailing={String(world.events.length)}
        >
          {world.events.slice(-5).map((event, index) => (
            <div
              key={`${event.tick}-${index}`}
              title={`${event.tick} ${event.kind} · ${event.detail}`}
              className="truncate text-slate-400"
            >
              <span className="text-slate-400">{event.tick}</span> {event.kind}{' '}
              · {event.detail}
            </div>
          ))}
        </Section>
      )}

      {network}

      <Section id="tel.controls" title="Controls">
        {/* Derived from the keymap rather than restated, so a rebind is on this
            panel in the same commit that stores it. Flight and the global acts
            only — the whole sheet is `?`, from any mode. */}
        <KeySheet contexts={['global', 'flight']} />
        <div className="mt-2 text-slate-400">
          console: <span className="text-sky-300">ir.help()</span> ·{' '}
          <span className="text-sky-300">ir.targets()</span> ·{' '}
          <span className="text-sky-300">ir.goTo(&apos;b:2&apos;)</span>
        </div>
      </Section>
    </div>
  )
}
