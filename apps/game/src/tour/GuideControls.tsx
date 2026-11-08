import { useSyncExternalStore } from 'react'
import { Mic, Pause, Play, Square } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { SurveyPrompt } from '../hud/SurveyPrompt.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { useActionTitle } from '../input/useKeymap.ts'
import {
  PLANETARIUM_GUIDE_VOICE,
  TELEMETRY_TRANSCRIPTS,
  usePersistentState,
} from '../state/preferences.ts'
import { SURVEYS } from '../telemetry/surveys.ts'
import { connectionOf, type GuideRuntime, statusLine } from './runtime.ts'
import type { GuideAccess } from './verdict.ts'

/*
 * The Guide panel: a voice picker and three controls, for an account the
 * guide is granted to. The panel is only offered to one (`verdict.ts`),
 * and the Worker refuses a session to anybody else whatever this draws.
 *
 * Start requests the microphone, posts the offer and shows Connecting until
 * the session starts; Pause becomes Resume and mutes both directions; End
 * closes the session and waits for its final usage. The one-line status and
 * the AI disclosure sit beneath, with the transcript switch and, after a
 * shared tour, its survey. There is no plan, no transcript, no typed
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
  const [transcripts, setTranscripts] = usePersistentState(
    TELEMETRY_TRANSCRIPTS,
  )
  const paused = state.activity.state === 'paused'
  const pauseTitle = useActionTitle(
    'guide.pause',
    paused ? 'Resume the guide' : 'Pause the guide',
  )
  const endTitle = useActionTitle('guide.end', 'End the guide')
  const connection = connectionOf(state.activity)
  const offline = connection === 'offline'
  const connecting = connection === 'connecting'
  const closing = connection === 'closing'
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
                  label={paused ? 'Resume' : 'Pause'}
                  icon={paused ? Play : Pause}
                  title={pauseTitle}
                  disabled={connecting || closing}
                  onClick={() => (paused ? runtime.resume() : runtime.pause())}
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
            {statusLine(state.activity)}
          </p>
          <p className="type-micro text-pretty text-slate-400">
            The guide is an AI voice. Starting sends your microphone to OpenAI,
            which holds the conversation and moves the camera through this app.
          </p>
          {/* Beside the disclosure because it is the same question asked the
              other way: where else what was said goes. Without it a tour
              still reports its timing, its tools and its cost, never a
              sentence (`tour/aiObservability.ts`). */}
          <SwitchRow
            label="Share transcripts"
            detail="Send what you and the guide say to PostHog, to improve the guide. Kept for 30 days."
            on={transcripts}
            changed={transcripts !== TELEMETRY_TRANSCRIPTS.initial}
            onChange={setTranscripts}
          />
          {/* Asked only of somebody who shared the tour it rates: a rating
              beside a transcript says what went wrong, and one without a
              transcript says only that something did. */}
          {offline && transcripts && state.lastTour !== null && (
            <SurveyPrompt
              name={SURVEYS.tour}
              subject={['tour_session_id', state.lastTour]}
            />
          )}
        </>
      )}
      {state.message && (
        <p className="type-ui text-pretty text-amber-200" role="status">
          {state.message}
        </p>
      )}
    </div>
  )
}
