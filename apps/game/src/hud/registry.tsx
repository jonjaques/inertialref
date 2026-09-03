import { Activity, Gauge, MonitorCog, Radio } from 'lucide-react'
import type { DockPanelDefinition } from '../dock/panels.ts'
import type { DevContext } from './context.ts'
import { ControlsPanel } from './ControlsPanel.tsx'
import { GraphicsPanel } from './GraphicsPanel.tsx'
import { PerfPanel } from './PerfPanel.tsx'
import { TelemetryPanel } from './TelemetryPanel.tsx'

/**
 * The author's instruments, as dockable panels.
 *
 * These were five tabs in one fixed panel in the top-right corner, and the tab
 * strip was doing two jobs it was bad at: it decided that exactly one of them
 * could be on screen, and it made "where does this readout live" a different
 * question in the planetarium — which had a docking system — than in flight,
 * which did not. Every one of them is now the same kind of object as a
 * catalog: draggable between panes, floatable over the scene, collapsible to
 * its header, and openable from the same menu.
 *
 * The zones are *defaults*, and they are chosen for the pairing an author
 * actually works in: the two readouts that answer "what is the simulation
 * doing" go left, and the three that answer "what am I asking it to do" go
 * right, so a telemetry-and-navigate session opens with one on each side and
 * nothing overlapping.
 *
 * The camera is not among them any more, and its absence is the phase's own
 * argument. The aperture, the focus and the exposure were reached by pressing
 * the console key, in the mode whose entire subject is looking — so the eye
 * moved to a planetarium panel of its own, and `/settings/camera` keeps the
 * lens section because a lens is a persisted preference and the same component
 * draws it.
 *
 * A panel that was never a tab: `controls`. The transport strip under the
 * old dock header held the clock, the attitude helpers and the save slot, and
 * it stayed on screen whichever tab was showing. With no tabs there is nothing
 * for it to stay on screen *over*, so it is a panel like the rest.
 *
 * Every one of them is `defaultOpen: false`, which is the disclosure's other
 * half. Pressing the bug says *the instruments exist* and puts six glyphs in
 * the menu; it does not put six panels over the sky. Opening all of them at
 * once was the first version, and on the first press it filled both panes —
 * which is the opposite of what a disclosure is for.
 */
export function devPanels(context: DevContext): readonly DockPanelDefinition[] {
  return [
    {
      id: 'controls',
      title: 'Controls',
      icon: Gauge,
      zone: 'right',
      defaultOpen: false,
      hint: 'the clock, the attitude helpers, the save slot and the harness',
      render: () => (
        <ControlsPanel
          engine={context.engine}
          commands={context.commands}
          onNotice={context.onNotice}
        />
      ),
    },
    {
      id: 'graphics',
      title: 'Graphics',
      /*
       * A monitor with a gear, not an aperture.
       *
       * An aperture is a *lens* — it is the one thing in an optical system that
       * the camera panel next door is actually about — and putting it on the
       * panel that carries anti-aliasing and the extended-range output signed
       * both glyphs over to the same idea. In a menu read by shape and position
       * that is not a near miss, it is two buttons that look like they do each
       * other's job. This one is about what the display is asked to show.
       */
      icon: MonitorCog,
      zone: 'right',
      defaultOpen: false,
      hint: 'render features and the extended-range override',
      render: () => (
        <GraphicsPanel render={context.render} onNotice={context.onNotice} />
      ),
    },
    {
      id: 'telemetry',
      title: 'Telemetry',
      icon: Radio,
      zone: 'left',
      defaultOpen: false,
      hint: 'what the simulation thinks is true, this tick',
      render: () => (
        <TelemetryPanel
          output={context.render.output}
          connection={context.connection}
          onCheckConnection={context.onCheckConnection}
        />
      ),
    },
    {
      id: 'perf',
      title: 'Perf',
      icon: Activity,
      zone: 'left',
      defaultOpen: false,
      hint: 'frame time, gpu time, and the budgets they are against',
      render: () => <PerfPanel engine={context.engine} />,
    },
  ]
}
