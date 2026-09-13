import { useState, useSyncExternalStore } from 'react'
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import {
  PLANETARIUM_GUIDE_VOICE,
  usePersistentState,
} from '../state/preferences.ts'
import type { GuideRuntime } from './runtime.ts'
import { GuideTransport } from './GuideTransport.tsx'
import { GuideTranscript } from './GuideTranscript.tsx'
import { GuideSources } from './GuideSources.tsx'
import { GuidePlan } from './GuidePlan.tsx'

export function GuideControls({ runtime }: { runtime: GuideRuntime }) {
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  )
  const [password, setPassword] = useState('')
  const [query, setQuery] = useState('')
  const [voice, setVoice] = usePersistentState(PLANETARIUM_GUIDE_VOICE)
  const authenticated = state.capabilities?.authenticated === true
  const available = state.capabilities?.available === true
  const connecting = state.connection === 'connecting'

  return (
    <div className="flex flex-col gap-3">
      <p className="type-ui text-pretty text-slate-400">
        Take a short tour, read this object, or ask about the sky. You can take
        the camera at any time.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Action
          label="Start tour"
          onClick={() => {
            void runtime.startTour('system')
          }}
          disabled={connecting}
          tone="primary"
        />
        <Action
          label="Saturn tour"
          onClick={() => {
            void runtime.startTour('saturn')
          }}
          disabled={connecting}
        />
        <Action label="Explain this object" onClick={() => runtime.explain()} />
      </div>
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
            <Action
              label="Unlock guide"
              type="submit"
              disabled={!password || connecting}
            />
          </div>
          <p className="type-micro text-slate-400">
            Local tours and object records work without signing in.
          </p>
        </form>
      )}
      {authenticated && available && (
        <div className="flex flex-col gap-2">
          <p className="type-ui text-pretty text-slate-400">
            The guide uses an AI voice. Starting voice sends microphone audio to
            OpenAI. The server processes your conversation and scene context to
            run the guide.
          </p>
          <div className="flex flex-wrap gap-1" aria-label="Guide voice">
            {(state.capabilities?.voices ?? []).map((choice) => (
              <Action
                key={choice}
                label={choice.charAt(0).toUpperCase() + choice.slice(1)}
                tone={voice === choice ? 'primary' : 'normal'}
                disabled={state.connection !== 'offline'}
                onClick={() => setVoice(choice)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Action
              label="Start voice"
              icon={Mic}
              disabled={
                connecting || state.voice || !state.capabilities?.features.live
              }
              onClick={() => {
                void runtime.startVoice(voice)
              }}
            />
            <Action
              label="Listen to tour"
              icon={Volume2}
              disabled={
                connecting ||
                state.voice ||
                !state.capabilities?.features.controlledSpeech
              }
              onClick={() => {
                void runtime.startTour('system', true, voice)
              }}
            />
            <Action
              label="Listen to Saturn"
              icon={Volume2}
              disabled={
                connecting ||
                state.voice ||
                !state.capabilities?.features.controlledSpeech
              }
              onClick={() => {
                void runtime.startTour('saturn', true, voice)
              }}
            />
          </div>
          <p className="type-micro text-slate-400">
            Listening needs no microphone and advances after each spoken stop.
            Live voice uses Next.
          </p>
        </div>
      )}
      {state.capabilities?.reason && (
        <p className="type-ui text-slate-400">{state.capabilities.reason}</p>
      )}
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          const value = query
          setQuery('')
          void runtime.ask(value)
        }}
      >
        <Input
          aria-label="Ask the guide"
          placeholder="An object name, a question, or a tour idea"
          value={query}
          maxLength={4000}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Action
          label="Ask"
          type="submit"
          disabled={!query.trim() || connecting}
        />
      </form>
      {state.voice && (
        <div className="flex flex-wrap gap-1.5">
          <Action
            label={
              state.microphoneMuted ? 'Unmute microphone' : 'Mute microphone'
            }
            icon={state.microphoneMuted ? MicOff : Mic}
            onClick={() => {
              void runtime.muteMicrophone(!state.microphoneMuted)
            }}
          />
          <span className="type-micro self-center text-slate-400" role="status">
            {state.microphoneMuted ? 'Microphone muted' : 'Microphone on'}
          </span>
        </div>
      )}
      {(state.voice || state.automatic) && (
        <Action
          label={state.guideMuted ? 'Unmute guide' : 'Mute guide'}
          icon={state.guideMuted ? VolumeX : Volume2}
          onClick={() => runtime.muteGuide(!state.guideMuted)}
        />
      )}
      <GuideTransport runtime={runtime} state={state} />
      <GuidePlan state={state} />
      {state.search && (
        <p className="type-micro text-slate-400" role="status">
          {state.search.running ? 'Searching' : 'Searched'}{' '}
          {state.search.systems} systems · {state.search.total} matches
          {state.search.running
            ? ` · ${Math.round(state.search.progress * 100)}%`
            : ''}
        </p>
      )}
      {state.message && (
        <p className="type-ui text-pretty text-amber-200" role="status">
          {state.message}
        </p>
      )}
      {state.explanation && (
        <p className="type-ui text-pretty text-slate-200">
          {state.explanation}
        </p>
      )}
      <GuideSources sources={state.sources} />
      <GuideTranscript transcripts={state.transcripts} />
    </div>
  )
}
