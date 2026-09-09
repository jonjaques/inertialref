import { StrictMode } from 'react'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from './components/ui/tooltip.tsx'
import type { InitialDocs } from './docs/initialDocs.ts'
import GameLoader from './GameLoader.tsx'
import { KeymapProvider } from './input/KeymapProvider.tsx'
import { PageShell } from './pages/PageShell.tsx'
import { ShellRouter } from './ShellRouter.tsx'

/** The same shell supplies server HTML and stays mounted throughout a session. */
export default function Root({
  url,
  initialDocs,
}: {
  url: string
  initialDocs?: InitialDocs
}) {
  return (
    <StrictMode>
      <ShellRouter url={url}>
        <MotionConfig reducedMotion="user">
          <TooltipProvider>
            <KeymapProvider>
              <div className="relative h-full w-full text-slate-200">
                <GameLoader />
                <PageShell initialDocs={initialDocs} />
              </div>
            </KeymapProvider>
          </TooltipProvider>
        </MotionConfig>
      </ShellRouter>
    </StrictMode>
  )
}
