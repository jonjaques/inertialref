import { Button } from '@/components/ui/button'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import type { DockPanelDefinition } from './panels.ts'

/**
 * One panel's name in the compact sheet's picker.
 *
 * Icon *and* word, unlike the desktop menu, and that is the whole reason this
 * is a separate control rather than a `MenuToggle`. The menu's glyphs are
 * legible because a pointer can hover one and be told what it is; a finger
 * cannot ask, so on a phone the hint has to be the label itself. The glyph
 * stays because it is the same glyph the desktop uses for the same panel, and
 * carrying it across is what makes the two arrangements one interface.
 *
 * `min-h-11` — 44 px, the platform minimum for a target hit one-handed while
 * the other hand is holding the device.
 */
export function CompactTab({
  panel,
  active,
  onClick,
}: {
  panel: DockPanelDefinition
  active: boolean
  onClick: () => void
}) {
  const Icon = panel.icon
  return (
    <Button
      variant="ghost"
      aria-pressed={active}
      onClick={(event) => {
        releaseFocus(event)
        onClick()
      }}
      className={`min-h-11 shrink-0 gap-1.5 rounded px-3 ${FOCUS_RING} ${
        active
          ? 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
          : 'text-slate-400 hover:bg-transparent active:bg-slate-800/60'
      }`}
    >
      <Icon className="size-4" />
      <span className="type-label">{panel.title}</span>
    </Button>
  )
}
