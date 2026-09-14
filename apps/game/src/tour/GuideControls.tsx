import { useState, useSyncExternalStore } from 'react'
import { Mic, Pause, Play, Square } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { useActionTitle } from '../input/useKeymap.ts'
import {
  PLANETARIUM_GUIDE_VOICE,
  usePersistentState,
} from '../state/preferences.ts'
import type { GuideRuntime } from './runtime.ts'

/*
 * The Guide panel: a voice picker and three controls.
 *
 * Start requests the microphone, posts the offer and shows Connecting until
 * the session starts; Pause becomes Resume and mutes both directions; End
 * closes the session and waits for its final usage. The one-line status and
 * the AI disclosure sit beneath. There is no plan, no transcript, no typed
 * request box: the conversation is the interface, and a drive script asks
 * through `ir.guideAsk`.
 */

export function GuideControls({ runtime }: { runtime: GuideRuntime }) {
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  )
  const [password, setPassword] = useState('')
  const [voice, setVoice] = usePersistentState(PLANETARIUM_GUIDE_VOICE)
  const pauseTitle = useActionTitle(
    'guide.pause',
    state.paused ? 'Resume the guide' : 'Pause the guide',
  )
  const endTitle = useActionTitle('guide.end', 'End the guide')
  const authenticated = state.capabilities?.authenticated === true
  const available = state.capabilities?.available === true
  const offline = state.connection === 'offline'
  const connecting = state.connection === 'connecting'
  const closing = state.connection === 'closing'
  const voices = state.capabilities?.voices ?? []

  return (
    <div className="flex flex-col gap-3">
      {!authenticated && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const value = password
            setPassword('')
            void runtime.login(value)
          }}
        >
          <label className="type-ui text-slate-400" htmlFor="guide-password">
            Private alpha password
          </label>
          <div className="flex gap-1.5">
            <Input
              id="guide-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <Action label="Unlock" type="submit" disabled={!password} />
          </div>
        </form>
      )}
      {authenticated && available && (
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
      {state.capabilities?.reason && (
        <p className="type-ui text-slate-400">{state.capabilities.reason}</p>
      )}
      {state.message && (
        <p className="type-ui text-pretty text-amber-200" role="status">
          {state.message}
        </p>
      )}
    </div>
  )
}
