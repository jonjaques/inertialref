import { Component, type ErrorInfo, type ReactNode } from 'react'
import { publishRuntime } from './runtimeState.ts'
import { runtimeFailure } from './runtimeFailure.ts'
import { RuntimeNotice } from './RuntimeNotice.tsx'
import { reportFailure } from './telemetry/posthog.ts'

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
    // Reported here first, because the component stack is only known here;
    // the store's own report of the same error object is then a duplicate
    // `telemetry/failures.ts` drops.
    reportFailure('runtime', error, {
      boundary: 'interactive view',
      react_component_stack: (info.componentStack ?? '').slice(0, 4000),
    })
    runtimeFailure.report('runtime', error)
    console.error('The interactive view stopped', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <RuntimeNotice
        failure={{ kind: 'runtime', detail: this.state.error.message }}
      />
    )
  }
}
