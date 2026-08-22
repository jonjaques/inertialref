import { Sparkles } from 'lucide-react'
import { AA_LEVELS } from '../render/output.ts'
import type { GraphicsState } from './controls.ts'
import { AaToggleGroup } from './AaToggleGroup.tsx'
import { Section } from './Section.tsx'
import { SwitchRow } from './SwitchRow.tsx'

/*
 * Render-feature switches.
 *
 * The panel exists for the shape of the problem: a rendering feature under
 * visual iteration needs an off switch, both to see a before/after without
 * reloading and to isolate an artifact to its source — which is exactly how
 * the lens flare's alpha-compositing bug was pinned to the flare rather than
 * the tone curve. Switches write plain engine fields; the frame loop reads
 * them, and nothing here re-renders per frame.
 */

export function GraphicsPanel({ graphics }: { graphics: GraphicsState }) {
  return (
    <div>
      <Section id="graphics.features" title="features">
        <SwitchRow
          bordered
          icon={Sparkles}
          label="lens flare"
          detail="ghosts, streak and glow when the star is in frame"
          on={graphics.lensFlare}
          onChange={graphics.onLensFlare}
        />
        <div className="mt-1 flex items-center justify-between gap-2 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-slate-300">anti-aliasing</span>
            <span className="min-w-0 truncate text-slate-400">
              2× is hardware msaa; 4× adds a 2×2 supersampled buffer
            </span>
          </span>
          {/*
           * Three named levels, so all three are on screen at once.
           *
           * This was one button that cycled — press it and the label changes —
           * which is the control you reach for when the set is unbounded. The
           * set is `off · 2× · 4×`, and a radio group says what the options
           * are, which one is current and how to reach a specific one in a
           * single press. It is also the shape a screen reader can report.
           */}
          <AaToggleGroup
            value={graphics.aa}
            values={AA_LEVELS}
            onChange={graphics.onAa}
          />
        </div>
      </Section>
    </div>
  )
}
