import { OUTPUT_PREFERENCES } from '../render/output.ts'
import {
  GROUND_DETAILS,
  SEA_DETAILS,
  TERRAIN_DETAILS,
} from '../render/quality.ts'
import {
  RENDER_GAMMA,
  RENDER_PICTURE,
  RENDER_LENS_FLARE,
  RENDER_SHIP,
  RENDER_SURFACE,
  RENDER_SENSOR,
  RENDER_THRUSTER_VARIATION,
  usePersistentState,
} from '../state/preferences.ts'
import {
  PICTURE_AA,
  PICTURE_SCALES,
  PICTURE_SHARPNESS,
  PICTURE_LABELS,
  pictureDimensions,
  pictureUpscales,
  resolvePicture,
} from '../render/picture.ts'
import { SHIP_IDS, SHIP_LABELS } from '../render/ships.ts'
import type { HudRenderState } from './controls.ts'
import { useDisplayDefaults } from './displayDefaults.ts'
import { OptionGroup } from './OptionGroup.tsx'
import { Section } from './Section.tsx'
import { SettingRow } from './SettingRow.tsx'
import { SliderControl } from './SliderControl.tsx'
import { SwitchRow } from './SwitchRow.tsx'

/*
 * What the display is asked to draw: the output range, the picture's
 * reconstruction, the lens flare, the surface's levers, and the ship's hull.
 *
 * The panel exists for the shape of the problem: a rendering feature under
 * visual iteration needs an off switch, both to see a before/after without
 * reloading and to isolate an artifact to its source — which is exactly how
 * the lens flare's alpha-compositing bug was pinned to the flare rather than
 * the tone curve. Switches write the preferences that own them, and
 * `state/engineKnobs.ts` carries each to the plain engine field the frame
 * loop reads; nothing here re-renders per frame.
 *
 * Drawn in two places — the author's dock and `/settings/display` — from one
 * definition per knob, which is what keeps those from being two anti-aliasing
 * switches that could drift apart. The rows are `SettingRow`s, whose container
 * query puts each control beside its label on the page and under it in the
 * 19rem panel, so the two places are one layout read at two widths.
 *
 * Ordered as a display menu reads: what reaches the screen first (range,
 * peak, gamma), then how the picture is reconstructed, then what is drawn into
 * it. The ship's hull is last because it is a choice about the scene rather
 * than about the display, and it is here because it is visual and nothing else.
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
  const [gamma, setGamma] = usePersistentState(RENDER_GAMMA)
  const [storedPicture, setPicture] = usePersistentState(RENDER_PICTURE)
  const picture = render.pictureOverride ?? storedPicture
  const pageOverride = render.pictureOverride != null
  const webgl = render.output?.backend === 'webgl'
  const resolvedPicture = resolvePicture(picture, webgl ? 'webgl' : 'webgpu')
  const dimensions =
    render.displaySize == null
      ? null
      : pictureDimensions(
          resolvedPicture,
          render.displaySize.width,
          render.displaySize.height,
        )
  const rebuilding = (): void => onNotice('rebuilding the sensor')
  const [surface, setSurface] = usePersistentState(RENDER_SURFACE)
  const [sensor, setSensor] = usePersistentState(RENDER_SENSOR)
  const [ship, setShip] = usePersistentState(RENDER_SHIP)
  const [thrusterVariation, setThrusterVariation] = usePersistentState(
    RENDER_THRUSTER_VARIATION,
  )
  const { rows: changed } = useDisplayDefaults()
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
  const encoding =
    render.output === null
      ? 'Starting'
      : `${render.output.gamut === 'display-p3' ? 'Display P3' : 'sRGB'} · ${mode === 'extended' ? 'extended HDR' : 'SDR'}`
  const linkSets = (): string | undefined =>
    pageOverride ? 'Set by the page link' : undefined

  return (
    <div className="@container flex flex-col gap-2">
      <Section
        id="graphics.output"
        title="Output"
        trailing={mode ?? 'starting'}
      >
        {/*
         * The ask and the answer, on one row.
         *
         * The group is the ask. The line under it is what the renderer came
         * back with — the gamut and the range actually in use, with a pip that
         * says whether `auto` reached extended — because the override exists
         * for the case where `auto` is wrong, and a control that could not show
         * what `auto` chose could not show that it was.
         */}
        <SettingRow
          label="HDR output"
          changed={changed.hdr}
          detail={
            <span className="flex flex-col gap-0.5">
              <span>
                {render.preference === 'extended' && mode === 'standard'
                  ? 'Extended HDR is unavailable here, so this display uses SDR.'
                  : 'Extended adds luminance headroom above white.'}{' '}
                Changing it rebuilds the renderer.
              </span>
              <span className="flex items-center gap-1.5 text-slate-300">
                {/* A non-text indicator, held to 3:1 like the connection pip
                    rather than to the 4.5:1 the ink beside it meets. */}
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${
                    mode === 'extended' ? 'bg-emerald-400' : 'bg-slate-400'
                  }`}
                />
                <span className="type-readout">
                  {encoding}
                  {resolved !== null && ' · chosen by auto'}
                </span>
              </span>
            </span>
          }
        >
          <OptionGroup
            label="HDR output"
            value={render.preference}
            values={OUTPUT_PREFERENCES}
            onChange={render.onPreference}
          />
        </SettingRow>
        {mode === 'extended' && (
          <SettingRow
            label="Peak luminance"
            changed={changed.peak}
            detail="How far above white the brightest highlight may reach on this display."
          >
            <SliderControl
              label="Peak luminance"
              min={1}
              max={2}
              step={0.05}
              value={sensor.peak}
              reading={`${sensor.peak.toFixed(2)}×`}
              spoken={`${sensor.peak.toFixed(2)} times white`}
              onChange={(peak) => setSensor((held) => ({ ...held, peak }))}
            />
          </SettingRow>
        )}
        {/*
         * Display gamma. The tone curve is authored for one room and cannot
         * know the viewer's, so where the midtones sit is theirs: a power on
         * the displayed range up to white, and nothing above it, so a star's
         * headroom and where a disk clips do not move. A uniform, so it takes
         * effect on the next frame without rebuilding the sensor.
         */}
        <SettingRow
          label="Gamma"
          changed={changed.gamma}
          detail="Where the midtones sit. Raise it in a bright room; 1.00 is the curve as authored."
        >
          <SliderControl
            label="Gamma"
            min={0.5}
            max={2}
            step={0.05}
            value={gamma}
            reading={gamma.toFixed(2)}
            spoken={gamma.toFixed(2)}
            onChange={setGamma}
          />
        </SettingRow>
      </Section>

      <Section id="graphics.picture" title="Picture">
        {pageOverride && (
          <p className="type-ui py-1 text-pretty text-slate-400">
            The page link sets this picture for this visit.
          </p>
        )}
        <SettingRow
          label="Anti-aliasing"
          changed={changed.aa}
          detail={
            webgl
              ? 'Temporal needs WebGPU.'
              : 'Temporal rebuilds edges across frames. Supersampling draws twice the width and height.'
          }
        >
          <OptionGroup
            label="Anti-aliasing"
            value={picture.aa}
            values={PICTURE_AA}
            labels={PICTURE_LABELS.aa}
            disabled={(aa) =>
              linkSets() ??
              (webgl && aa === 'temporal' ? 'Needs WebGPU' : undefined)
            }
            onChange={(aa) => {
              setPicture((held) => ({
                ...held,
                aa,
                scale: aa === 'supersample' ? 'native' : held.scale,
              }))
              rebuilding()
            }}
            className="max-w-full flex-wrap"
          />
        </SettingRow>
        <SettingRow
          label="Render scale"
          changed={changed.scale}
          detail={`${
            dimensions === null
              ? 'The render size appears when the display is ready.'
              : `Draws ${dimensions.render.width}×${dimensions.render.height} for a ${dimensions.display.width}×${dimensions.display.height} display.`
          }${webgl ? ' Reduced scales need WebGPU.' : picture.aa === 'supersample' ? ' Supersampling draws at native scale.' : ''}`}
        >
          <OptionGroup
            label="Render scale"
            value={picture.scale}
            values={PICTURE_SCALES}
            labels={PICTURE_LABELS.scale}
            disabled={(scale) =>
              linkSets() ??
              (scale !== 'native' && webgl
                ? 'Needs WebGPU'
                : scale !== 'native' && picture.aa === 'supersample'
                  ? 'Supersampling uses native scale'
                  : undefined)
            }
            onChange={(scale) => {
              setPicture((held) => ({
                ...held,
                scale: held.aa === 'supersample' ? 'native' : scale,
              }))
              rebuilding()
            }}
            className="max-w-full flex-wrap"
          />
        </SettingRow>
        <SettingRow
          label="Sharpness"
          changed={changed.sharpness}
          detail="Sharpens rebuilt edges. Applies to temporal anti-aliasing and reduced render scales."
        >
          <OptionGroup
            label="Sharpness"
            value={picture.sharpness}
            values={PICTURE_SHARPNESS}
            labels={PICTURE_LABELS.sharpness}
            disabled={() =>
              linkSets() ??
              (!pictureUpscales(resolvedPicture)
                ? 'Choose temporal anti-aliasing or a reduced render scale'
                : undefined)
            }
            onChange={(sharpness) => {
              setPicture((held) => ({ ...held, sharpness }))
              rebuilding()
            }}
          />
        </SettingRow>
      </Section>

      <Section id="graphics.effects" title="Effects">
        {/*
         * The flare everywhere, on or off. How much of its ghost-and-streak
         * stack a picture shows is the planetarium Lens panel's glare, which is
         * a choice about one photograph; this is whether there is a flare to
         * choose an amount of, in every mode.
         */}
        <SwitchRow
          divided
          label="Lens flare"
          detail="The glow, ghosts and streaks a bright star throws through the lens, in every mode."
          changed={changed.flare}
          on={lensFlare}
          onChange={setLensFlare}
        />
      </Section>

      {/*
       * The surface's levers. Each is one measured cost with a name on it
       * rather than a rung of a quality ladder — `render/quality.ts` says what
       * each step spends — and none rebuilds anything: the frame loop reads the
       * record and the materials compare before they write.
       */}
      <Section id="graphics.surface" title="Surface">
        <SettingRow
          label="Terrain"
          changed={changed.terrain}
          detail="How large a ground cell may grow on screen before it is refined."
        >
          <OptionGroup
            label="Terrain"
            value={surface.terrain}
            values={TERRAIN_DETAILS}
            onChange={(terrain) => setSurface((held) => ({ ...held, terrain }))}
          />
        </SettingRow>
        <SettingRow
          label="Ground detail"
          changed={changed.ground}
          detail="The fine relief drawn inside each cell. Lean keeps the coarsest."
        >
          <OptionGroup
            label="Ground detail"
            value={surface.ground}
            values={GROUND_DETAILS}
            onChange={(ground) => setSurface((held) => ({ ...held, ground }))}
          />
        </SettingRow>
        <SettingRow
          label="Sea"
          changed={changed.sea}
          detail="Full refracts the seabed and mirrors the land. Plain reflects the sky. Flat has no waves."
        >
          <OptionGroup
            label="Sea"
            value={surface.sea}
            values={SEA_DETAILS}
            onChange={(sea) => setSurface((held) => ({ ...held, sea }))}
          />
        </SettingRow>
        <SwitchRow
          divided
          label="Rocks"
          detail="The scattered stones on the ground."
          changed={changed.rocks}
          on={surface.rocks}
          onChange={(rocks) => setSurface((held) => ({ ...held, rocks }))}
        />
      </Section>

      {/*
       * Which hull the ship is drawn as.
       *
       * A closed set from the ship manifest, so it is an `OptionGroup` like the
       * anti-aliasing and output rows — the stored value is the id and the chip
       * is the short label, because a saved ship must not change when a name is
       * reworded. The hull appears in flight and, when the ship layer is on, in
       * the planetarium; the debug cone stands in until the chosen one loads.
       */}
      <Section id="graphics.ship" title="Ship">
        <SettingRow
          label="Hull"
          changed={changed.ship}
          detail="The ship flight draws, and the planetarium when its ship layer is on."
        >
          <OptionGroup
            label="Hull"
            value={ship}
            values={SHIP_IDS}
            labels={SHIP_LABELS}
            onChange={setShip}
          />
        </SettingRow>
        <SwitchRow
          divided
          label="Thruster variation"
          detail="Uneven valve timing and tiny settling puffs. Visual only."
          changed={changed.thrusters}
          on={thrusterVariation}
          onChange={setThrusterVariation}
        />
      </Section>
    </div>
  )
}
