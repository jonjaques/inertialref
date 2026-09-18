# The guide's scripts

The guide is one voice: GPT Live listens and speaks, GPT-6 Astra thinks
through Responses delegation, and the browser executes every tool over the
WebRTC data channel. The design is
[ADR-0042](../../docs/adr/0042-the-guide-speaks-in-one-voice.md), and the
execution boundary it keeps is
[ADR-0041](../../docs/adr/0041-the-guide-requests-the-view.md).

Provider calls run only when an operator invokes a script with
`--allow-spend`. CI runs the fake-channel tests under `apps/game/src/tour/`
and the Worker tests under `apps/server/src/tour/` without credentials. The
scripts read `.env.local` through Node's environment loader and never print
credentials or raw provider errors.

## Development

`pnpm dev` starts Vite and the Worker. `dev.mjs` is the Worker half: it passes
the repository's gitignored `.env.local` to Wrangler alone, so the client
bundle never sees `OPENAI_API_KEY` or `TOUR_GUIDE_PASSWORD`.

The browser console has three harness verbs for the guide, all of which use
the runtime the dock panel owns rather than opening a second one:

- `ir.guideStatus()` reads connection, state, pending calls, and usage.
- `ir.guideTrace(true)` records the last 200 data-channel events and
  commands, with audio and the password form excluded; `ir.guideTrace()`
  returns detached copies and `ir.guideTrace(false)` stops.
- `await ir.guideAsk(text)` queues a typed request as the visitor's own words
  and runs the backend, which is how a drive script asks for a tour without a
  microphone.

## Live probes

`live-probe/` holds the phase-0 checks: real GPT Live sessions with Responses
delegation to Astra and fake tools.

```
node scripts/tour/live-probe/beats.mjs --allow-spend
node scripts/tour/live-probe/webrtc.mjs --allow-spend
```

`beats.mjs` opens a primary WebSocket session, streams synthetic visitor
clips, and measures the beat shape: a non-blocking move, an arrival nudge, the
quiet clock, a continue nudge, and a spoken correction during travel.
`webrtc.mjs` serves a page to a headless Chrome that owns a WebRTC session
under the data-channel allow list, runs the tool loop from the browser,
confirms `session.update` is refused, drops the peer connection without
closing, and attaches a sideband to see whether the session survived. Both
write a JSONL trace and a summary under `.scratch/live-probe/` with audio
payloads dropped and no credentials; visitor clips are cached there so a rerun
pays for Live and Astra only. A run is a few minutes and under a dollar. The
plan's § 12 records what they found.

## Listening

Use the application through `node scripts/drive.mjs`, following the `drive`
skill. Ask the same requests of several voices — a Saturn tour, "what is that
point to the left?", a correction during travel — and record the browser,
device, voice, prompt version, and the listening scores. Hide voice names
during comparison where practical, and do not infer a preferred voice from one
greeting. **Listen with the driver's window on screen:** an off-screen occluded
window produces no audio pipeline, so the remote-track clock reads every beat
as silent and the tour advances on the clock's start timeout rather than on the
voice. That proves the loop, not the pacing.

## The conversation replay

`replay.mjs` reads a recorded session and checks the beat structure, the one
camera move per turn, and the pacing the clock is tuned for. It replaces the
old director grader: the backend composes the tour on the spot, so there is no
plan to score. It talks to no provider.

```
node scripts/tour/replay.mjs .scratch/guide-live/session-*.json
node scripts/tour/replay.mjs --floor 0.003 --quiet 2500 <recording> …
```

The recording is the in-page recorder's dump under `.scratch/guide-live/`
(every data-channel message both directions, the remote-track level as the
clock samples it, and the runtime's notes; no audio, no credentials — see the
`inertialref-guide-human-session-rig` memory). The floor and quiet default to
the clock's own numbers; pass others to see how the same conversation would
have beaten under different ones. It exits nonzero on any failed check, so a
committed recording could gate the pacing in CI.

[Live delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[Live session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations),
[server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live),
and [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
describe the provider contracts.
