import { Component, type ErrorInfo, type ReactNode } from 'react'
import { publishRuntime } from './runtimeState.ts'

/** A renderer failure leaves the server-rendered pages and their router alive. */
export class GameRuntimeBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null }

  static getDerivedStateFromError(cause: unknown): { error: Error } {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    publishRuntime(null)
    console.error('The interactive view stopped', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="hud-layer pointer-events-none absolute">
        <div
          role="alert"
          className="type-readout pointer-events-auto absolute bottom-3 left-3 z-50 max-w-[min(36rem,calc(100%-1.5rem))] rounded border border-rose-400/40 bg-slate-950/85 px-3 py-2 text-slate-300"
        >
          <p className="text-rose-300">The interactive view stopped.</p>
          <p className="mt-1 break-words">{this.state.error.message}</p>
          <p className="mt-1 text-slate-400">
            Reload to try the interactive view again.
          </p>
        </div>
      </div>
    )
  }
}
