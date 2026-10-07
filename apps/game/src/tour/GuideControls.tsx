import { useSyncExternalStore } from 'react'
import { GUIDE_REFUSAL_SENTENCES } from '@inertialref/protocol'
import { Mic, Pause, Play, Square } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { useActionTitle } from '../input/useKeymap.ts'
import {
  PLANETARIUM_GUIDE_VOICE,
  usePersistentState,
} from '../state/preferences.ts'
import type { GuideRuntime } from './runtime.ts'
import type { GuideAccess } from './verdict.ts'

/*
 * The Guide panel: a voice picker and three controls, for an account the
 * guide is granted to. The panel is only offered to one (`verdict.ts`),
 * and the Worker refuses a session to anybody else whatever this draws.
 *
 * Start requests the microphone, posts the offer and shows Connecting until
 * the session starts; Pause becomes Resume and mutes both directions; End
 * closes the session and waits for its final usage. The one-line status and
 * the AI disclosure sit beneath. There is no plan, no transcript, no typed
 * request box: the conversation is the interface, and a drive script asks
 * through `ir.guideAsk`.
 */

export function GuideControls({
  runtime,
  access,
}: {
  runtime: GuideRuntime
  access: GuideAccess
}) {
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  )
  const [voice, setVoice] = usePersistentState(PLANETARIUM_GUIDE_VOICE)
  const pauseTitle = useActionTitle(
    'guide.pause',
    state.paused ? 'Resume the guide' : 'Pause the guide',
  )
  const endTitle = useActionTitle('guide.end', 'End the guide')
  const offline = state.connection === 'offline'
  const connecting = state.connection === 'connecting'
  const closing = state.connection === 'closing'
  const voices = access.state === 'granted' ? access.voices : []

  return (
    <div className="flex flex-col gap-3">
      {access.state === 'granted' && (
        <>
          <div className="flex flex-wrap gap-1" aria-label="Guide voice">
            {voices.map((choice) => (
              <Action
                key={choice}
                label={choice.charAt(0).toUpperCase() + choice.slice(1)}
                tone={voice === choice ? 'primary' : 'normal'}
                disabled={!offline}
                onClick={() => setVoice(choice)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {offline ? (
              <Action
                label="Start"
                icon={Mic}
                tone="primary"
                onClick={() => {
                  void runtime.start(voice)
                }}
              />
            ) : (
              <>
                <Action
                  label={state.paused ? 'Resume' : 'Pause'}
                  icon={state.paused ? Play : Pause}
                  title={pauseTitle}
                  disabled={connecting || closing}
                  onClick={() =>
                    state.paused ? runtime.resume() : runtime.pause()
                  }
                />
                <Action
                  label="End"
                  icon={Square}
                  title={endTitle}
                  disabled={closing}
                  onClick={() => {
                    void runtime.end()
                  }}
                />
              </>
            )}
          </div>
          <p className="type-readout text-slate-400" role="status">
            {offline ? 'Ready' : state.status}
          </p>
          <p className="type-micro text-pretty text-slate-400">
            The guide is an AI voice. Starting sends your microphone to OpenAI,
            which holds the conversation and moves the camera through this app.
          </p>
        </>
      )}
      {/* A signed-out or ungranted refusal is reachable only in the moment
          between a sign-out, or a revoked grant, and the panel being
          withdrawn. */}
      {access.state === 'refused' && (
        <p className="type-ui text-slate-400">
          {GUIDE_REFUSAL_SENTENCES[access.reason]}
        </p>
      )}
      {state.message && (
        <p className="type-ui text-pretty text-amber-200" role="status">
          {state.message}
        </p>
      )}
    </div>
  )
}
