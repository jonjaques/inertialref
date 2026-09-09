import { useLocation } from 'react-router'
import type { DevWorkspace } from '../dock/workspace.ts'
import { DocsContentContext, type InitialDocs } from '../docs/initialDocs.ts'
import { useManifest, usePage } from '../docs/useDocs.ts'
import { ChromeContext } from '../hud/chrome.ts'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { useRuntime } from '../runtimeState.ts'
import { useEngine } from '../state/engineStore.ts'
import { RENDER_HDR, usePersistentState } from '../state/preferences.ts'
import { DocumentMeta } from './DocumentMeta.tsx'
import { ModeRoutes } from './ModeRoutes.tsx'
import { OverlayRoutes } from './OverlayRoutes.tsx'
import { modeForPath, resolvedLocation } from './paths.ts'

const NO_DEV: DevWorkspace = {
  panels: [],
  open: false,
  onOpenChange: () => {},
}
const ignoreNotice = (): void => {}

/** Readable pages exist before the catalog, workers, or renderer have started. */
export function PageShell({ initialDocs }: { initialDocs?: InitialDocs }) {
  const runtime = useRuntime()
  const location = resolvedLocation(useLocation())
  const route =
    location.pathname.length > 1
      ? location.pathname.replace(/\/+$/, '')
      : location.pathname
  const mode = modeForPath(route)
  const cinema = useEngine((snapshot) => snapshot.cinema)
  const chrome = useEngine((snapshot) => snapshot.presentation.chrome)
  const [hdr, setHdr] = usePersistentState(RENDER_HDR)
  const manifest = useManifest(initialDocs?.manifest, mode === 'docs')
  const page = usePage(manifest.value, route, initialDocs?.page)
  const visible = runtime === null || !cinema || mode === 'cinema'

  return (
    <DocsContentContext value={{ manifest, page }}>
      <DocumentMeta />
      <ChromeContext value={runtime !== null && !chrome}>
        <div className="hud-layer pointer-events-none absolute">
          {visible && (
            <>
              <div
                className={`pointer-events-none absolute inset-0 ${mode === 'cinema' ? 'z-30' : 'z-0'}`}
              >
                <ErrorBoundary
                  what={`the ${mode} mode`}
                  className="pointer-events-auto absolute inset-0"
                >
                  <ModeRoutes
                    engine={runtime?.engine ?? null}
                    dev={runtime?.dev ?? NO_DEV}
                    onNotice={runtime?.onNotice ?? ignoreNotice}
                  />
                </ErrorBoundary>
              </div>
              <div className="pointer-events-none absolute inset-0 z-40">
                <ErrorBoundary
                  what="the page overlay"
                  className="pointer-events-auto absolute inset-0"
                >
                  <OverlayRoutes
                    render={
                      runtime?.render ?? {
                        preference: hdr,
                        output: null,
                        onPreference: setHdr,
                      }
                    }
                    onNotice={runtime?.onNotice ?? ignoreNotice}
                  />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </ChromeContext>
    </DocsContentContext>
  )
}
