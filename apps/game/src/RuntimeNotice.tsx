import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { allowGraphicsRetry } from './graphicsSession.ts'
import { Action } from './hud/Action.tsx'
import { DOCS, HOME, modeForPath, resolvedLocation } from './pages/paths.ts'
import type { RuntimeFailure } from './runtimeFailure.ts'

/** Graphics can stop while navigation and documentation remain available. */
export function RuntimeNotice({ failure }: { failure: RuntimeFailure }) {
  const mode = modeForPath(resolvedLocation(useLocation()).pathname)
  const [dismissed, setDismissed] = useState(false)
  const reading = mode === 'menu' || mode === 'docs'
  if (dismissed) return null
  return (
    <div className="hud-layer pointer-events-none absolute z-50">
      <div
        className={
          reading
            ? 'absolute bottom-3 left-3 max-h-[calc(100%-1.5rem)] max-w-[min(32rem,calc(100%-1.5rem))] overflow-y-auto'
            : 'absolute inset-0 flex items-center justify-center bg-slate-950 p-6'
        }
      >
        <section
          role="alert"
          className="pointer-events-auto max-h-full max-w-lg overflow-y-auto rounded border border-sky-500/30 bg-slate-950 p-5 text-slate-300"
        >
          <div className="flex items-start justify-between gap-4">
            <h1 className="type-heading text-sky-200">
              {failure.kind === 'runtime'
                ? 'Interactive view unavailable'
                : 'Graphics not supported'}
            </h1>
            <Action label="Dismiss" onClick={() => setDismissed(true)} />
          </div>
          <p className="type-body mt-3">
            {failure.kind === 'restart'
              ? 'The previous graphics session did not close normally. Graphics are paused to prevent another restart.'
              : failure.kind === 'unsupported'
                ? 'This browser could not start a compatible graphics renderer. Try a browser with WebGPU support.'
                : failure.kind === 'graphics'
                  ? 'The graphics renderer stopped or could not draw this scene on your device.'
                  : 'The interactive view could not start. You can still browse the site.'}
          </p>
          <p className="type-body mt-3">
            Home and documentation remain available. You can try again after
            updating your browser or enabling hardware acceleration.
          </p>
          <details className="type-readout mt-3 text-slate-400">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-2 max-h-32 overflow-auto break-words">
              {failure.detail}
            </p>
          </details>
          <nav
            aria-label="Continue without graphics"
            className="type-ui mt-4 flex flex-wrap items-center gap-4 text-sky-300"
          >
            <Link to={HOME}>Home</Link>
            <Link to={DOCS}>Documentation</Link>
            <Action
              label="Try graphics again"
              onClick={() => {
                allowGraphicsRetry()
                window.location.reload()
              }}
            />
          </nav>
        </section>
      </div>
    </div>
  )
}
