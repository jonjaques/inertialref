import { DockPanel } from './DockPanel.tsx'
import { DropLine } from './DropLine.tsx'
import type { PaneZone } from './layout.ts'
import type { DockPanelDefinition } from './panels.ts'
import type { Workspace } from './useWorkspace.ts'

/** One panel in a pane, with the drop indicator that may precede it. */
export function PanelSlot({
  definition,
  zone,
  indicate,
  workspace,
}: {
  definition: DockPanelDefinition
  zone: PaneZone
  indicate: boolean
  workspace: Workspace
}) {
  return (
    <>
      {indicate && <DropLine />}
      <DockPanel definition={definition} zone={zone} workspace={workspace} />
    </>
  )
}
