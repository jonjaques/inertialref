import { Mountain, Sparkles } from 'lucide-react'
import { AA_LEVELS, OUTPUT_PREFERENCES } from '../render/output.ts'
import {
  GROUND_DETAILS,
  SEA_DETAILS,
  TERRAIN_DETAILS,
} from '../render/quality.ts'
import {
  RENDER_AA,
  RENDER_LENS_FLARE,
  RENDER_SURFACE,
  usePersistentState,
} from '../state/preferences.ts'
import type { HudRenderState } from './controls.ts'
import { OptionGroup } from './OptionGroup.tsx'
import { Section } from './Section.tsx'
import { SurfaceRow } from './SurfaceRow.tsx'
import { SwitchRow } from './SwitchRow.tsx'

/*
 * Render-feature switches, and the extended-range override.
 *
 * The panel exists for the shape of the problem: a rendering feature under
 * visual iteration needs an off switch, both to see a before/after without
 * reloading and to isolate an artifact to its source — which is exactly how
 * the lens flare's alpha-compositing bug was pinned to the flare rather than
 * the tone curve. Switches write the preferences that own them, and
 * `state/engineKnobs.ts` carries each to the plain engine field the frame
 * loop reads; nothing here re-renders per frame.
 *
 * The knobs are read from their definitions rather than handed down. The
 * panel is drawn in two places — the dock and `/settings/display` — and one
 * definition per knob is what keeps those from being two anti-aliasing
 * switches that could drift apart.
 *
 * The HDR override moved here from the transport strip, where it was the one
 * control on a row of *verbs* that was a preference. It is a rendering setting
 * and this is the rendering panel; that it rebuilds the renderer to take effect
 * is a fact about the property, not a reason to keep it beside `save`.
 */

export function GraphicsPanel({
  render,
  onNotice,
}: {
  render: HudRenderState
  /** Say what a press just did, through the notice the shell flashes. */
  onNotice: (message: string) => void
}) {
  const [lensFlare, setLensFlare] = usePersistentState(RENDER_LENS_FLARE)
  const [aa, setAa] = usePersistentState(RENDER_AA)
  const [surface, setSurface] = usePersistentState(RENDER_SURFACE)
  const mode = render.output?.mode ?? null
  /*
   * Whether `auto` guessed something other than the obvious.
   *
   * This is the whole reason the override exists — spike 1 found that `auto` is
   * a capability probe rather than a display test, so it will be wrong for
   * somebody on every browser, in both directions — and it is the one thing the
   * control could never say when it was a button whose label was the
   * preference. Under an explicit preference the two agree by construction and
   * repeating the resolved mode is noise.
   */
  const resolved = render.preference === 'auto' ? mode : null

  return (
    <div className="flex flex-col gap-2">
      <Section id="graphics.features" title="Features">
        <SwitchRow
          bordered
          icon={Sparkles}
          label="Lens Flare"
          detail="ghosts, streak and glow when the star is in frame"
          on={lensFlare}
          onChange={setLensFlare}
        />
        {/* The same two-line shape `SwitchRow` uses, for the same reason: on
            one line the explanation was the half that truncated, and what a
            reader saw was "anti-aliasing  2× is ha…". */}
        <div className="mt-1 flex min-h-9 items-center justify-between gap-2.5 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="type-ui text-slate-300">Anti-aliasing</span>
            <span className="type-ui text-pretty text-slate-400">
              2× is hardware MSAA; 4× adds a 2×2 supersampled buffer
            </span>
          </span>
          <OptionGroup
            label="Anti-aliasing"
            value={aa}
            values={AA_LEVELS}
            onChange={(level) => {
              // Crossing the MSAA boundary rebuilds the renderer, so say so —
              // the stall would otherwise read as a hang.
              setAa(level)
              onNotice(`anti-aliasing ${level}`)
            }}
          />
        </div>
      </Section>

      {/*
       * The surface's levers. Each is one measured cost with a name on it
       * rather than a rung of a quality ladder — `render/quality.ts` says what
       * each step spends — and none rebuilds anything: the frame loop reads the
       * record and the materials compare before they write.
       */}
      <Section id="graphics.surface" title="Surface">
        <SurfaceRow
          label="Terrain"
          detail="how many pixels a ground cell may cover before it is refined"
          value={surface.terrain}
          values={TERRAIN_DETAILS}
          onChange={(terrain) => setSurface((held) => ({ ...held, terrain }))}
        />
        <SurfaceRow
          label="Ground detail"
          detail="the per-pixel octaves under a mesh cell; lean keeps the coarse one"
          value={surface.ground}
          values={GROUND_DETAILS}
          onChange={(ground) => setSurface((held) => ({ ...held, ground }))}
        />
        <SurfaceRow
          label="Sea"
          detail="full refracts the seabed; plain reflects the sky; flat has no waves"
          value={surface.sea}
          values={SEA_DETAILS}
          onChange={(sea) => setSurface((held) => ({ ...held, sea }))}
        />
        <SwitchRow
          bordered
          icon={Mountain}
          label="Rocks"
          detail="the instanced scatter on the ground"
          on={surface.rocks}
          onChange={(rocks) => setSurface((held) => ({ ...held, rocks }))}
        />
      </Section>

      <Section
        id="graphics.output"
        title="Output"
        trailing={mode ?? 'starting'}
      >
        {/*
         * One control, three states, and what came back underneath it.
         *
         * This was a `Row` pair — preference above, resolved below — plus a
         * button that cycled. Three problems in one section: reaching a
         * specific state cost up to three presses and three renderer rebuilds;
         * the two rows read as two settings rather than as an ask and an
         * answer; and the resolved mode was stated even when it could not
         * possibly disagree. The group is the ask. The line under it is the
         * answer, and it only appears when there is one worth reading.
         */}
        <div className="rounded border border-slate-800/80 bg-slate-900/40 p-1.5">
          <OptionGroup
            label="Extended-range output"
            className="w-full [&>*]:flex-1"
            value={render.preference}
            values={OUTPUT_PREFERENCES}
            onChange={render.onPreference}
          />
          {/* Wrapping rather than truncating: the resolved state and the note
              share a 19rem column and neither is expendable, so they take two
              lines when they do not fit on one. */}
          <p className="type-ui mt-1.5 flex flex-wrap items-center gap-x-1.5 text-slate-400">
            {resolved !== null && (
              <>
                {/* A non-text indicator, held to 3:1 like the connection pip
                    rather than to the 4.5:1 the ink beside it meets. */}
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${
                    resolved === 'extended' ? 'bg-emerald-400' : 'bg-slate-400'
                  }`}
                />
                <span className="shrink-0 text-slate-300">
                  auto → {resolved}
                </span>
                <span aria-hidden className="text-slate-700">
                  ·
                </span>
              </>
            )}
            <span>rebuilds the renderer</span>
          </p>
        </div>
      </Section>
    </div>
  )
}
