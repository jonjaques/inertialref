import { DockPanel } from './DockPanel.tsx'
import { DropLine } from './DropLine.tsx'
import type { DockZone } from './layout.ts'
import type { DockPanelDefinition } from './panels.ts'

/** One panel in a zone, with the drop indicator that may precede it. */
export function PanelSlot({
  definition,
  zone,
  indicate,
  onHide,
}: {
  definition: DockPanelDefinition
  zone: DockZone
  indicate: boolean
  onHide: (id: string) => void
}) {
  return (
    <>
      {indicate && <DropLine zone={zone} />}
      <DockPanel definition={definition} zone={zone} onHide={onHide} />
    </>
  )
}
