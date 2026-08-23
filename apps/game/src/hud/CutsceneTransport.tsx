import { Pause, Play, RotateCcw, X } from 'lucide-react'
import { FrameScrubber } from './FrameScrubber.tsx'
import { TransportButton } from './TransportButton.tsx'

/**
 * The debug transport: the one interactive island in an otherwise
 * pointer-transparent layer.
 *
 * Same verbs as the console — restart, pause, resume, seek, stop — so anything
 * done here is reproducible there. Off by default: there are two things that
 * can put a transport on screen, this and the cinema player, and two playheads
 * a person can disagree with is worse than none. `App` turns it on with the
 * debug overlay, which is where a scrub-while-flying belongs.
 */
export function CutsceneTransport({
  frame,
  durationFrames,
  paused,
  onGrab,
  onSeek,
  onTogglePlay,
  onStop,
}: {
  frame: number
  durationFrames: number
  paused: boolean
  onGrab: () => void
  onSeek: (frame: number) => void
  onTogglePlay: () => void
  onStop: () => void
}) {
  return (
    <div className="pointer-events-auto absolute bottom-5 left-1/2 flex w-[34rem] max-w-[80vw] -translate-x-1/2 items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-950/70 px-3 py-1.5 type-readout text-slate-300 backdrop-blur">
      <TransportButton
        label="Restart"
        icon={RotateCcw}
        onClick={() => onSeek(0)}
      />
      <TransportButton
        label={paused ? 'Play' : 'Pause'}
        icon={paused ? Play : Pause}
        onClick={onTogglePlay}
      />
      <TransportButton
        label="Stop and restore the ship (Esc)"
        icon={X}
        onClick={onStop}
      />
      <FrameScrubber
        frame={frame}
        durationFrames={durationFrames}
        onGrab={onGrab}
        onSeek={onSeek}
        className="flex-1"
      />
      <span className="w-16 shrink-0 text-right text-slate-400 tabular-nums">
        f{Math.floor(frame)}
      </span>
    </div>
  )
}
