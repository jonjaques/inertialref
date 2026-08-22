import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Action } from './widgets.tsx'

/*
 * A wall between one readout's throw and the canvas.
 *
 * React unmounts the entire tree when a render throws, and in this app the tree
 * contains the `<Canvas>` — so a body with no name, a `HarnessStatus` shaped
 * like last week's, or a division by a zero-length series does not produce a
 * broken row. It produces a black screen with a healthy console, which is the
 * exact symptom `render/presentationWatchdog.ts` exists to recover from,
 * arriving by a route that watchdog cannot see. A debug overlay whose failure
 * mode is "the thing you were watching disappears" is worse than no overlay.
 *
 * Deliberately many small boundaries rather than one. A throw in the perf plot
 * costs the perf tab; the flight strip, the other tabs and the scene keep
 * running, and `what` names the piece so the fallback can say which one gave
 * up. Reset by remounting — the call sites pass a `key` — so switching tab and
 * back is the recovery, and `retry` is there for when there is no tab to leave.
 *
 * A class because there is still no hook form of this. It catches renders,
 * lifecycles and effects and nothing else: not event handlers, not rejected
 * promises, not the cutscene's rAF loop. `NavPanel.run`'s try/catch is not made
 * redundant by any of this, and neither is `probeHealth`'s.
 */

export class ErrorBoundary extends Component<
  {
    readonly what: string
    /**
     * Applied to the fallback only.
     *
     * The chrome this wraps positions *itself* — the dock is `absolute right-3
     * top-3`, the strip `bottom-3 left-3` — so a fallback rendered bare would
     * land at the origin of a `pointer-events-none` layer, unstyled and with an
     * unclickable retry. The boundary cannot inherit a position it never had;
     * the call site says where the hole is.
     */
    readonly className?: string
    readonly children: ReactNode
  },
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null }

  static getDerivedStateFromError(cause: unknown): { error: Error } {
    return {
      error: cause instanceof Error ? cause : new Error(String(cause)),
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // `console.error` rather than `logHub`: the two things worth having here
    // are a live Error object and a component stack, and both are devtools
    // affordances — one expands to a clickable source frame, the other is
    // twenty lines that would be a single unreadable field in a log record.
    console.error(`[hud] ${this.props.what} failed`, error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div
        className={`rounded border border-rose-400/40 bg-slate-950/80 px-2 py-1.5 ${this.props.className ?? ''}`}
      >
        <div className="text-rose-300">{this.props.what} stopped drawing</div>
        <div className="mt-1 max-h-24 overflow-auto break-words text-slate-400">
          {error.message || 'no message'}
        </div>
        {/* Stacked, not inline. The dock is 27rem and the sentence is the
            width of most of it, so a row put the button beside two wrapped
            lines and top-aligned it against them. */}
        <div className="mt-1 text-slate-600">
          the simulation is still running · stack in the console
        </div>
        <div className="mt-1.5">
          <Action
            label="retry"
            title="Render it again — the simulation kept running underneath"
            onClick={() => this.setState({ error: null })}
          />
        </div>
      </div>
    )
  }
}
