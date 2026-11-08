# The guide: eight weeks in

A spike, 7 Nov 2026. The guide shipped on 14 Sep 2026 and reached production
on 30 Sep. This page records what the provider has changed since, what a
review of the implementation found, how a transcript is kept for the visitors
who ask for one, and which model should think behind the voice. It is a plan,
so it promises. When a phase lands, its decision moves into an ADR and the
section here goes; cite the ADR, not this page.

| Reads with                                                                                  | For                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [ADR-0042](../../docs/adr/0042-the-guide-speaks-in-one-voice.md)                            | One voice, the browser as the middle, the remote-track clock |
| [ADR-0041](../../docs/adr/0041-the-guide-requests-the-view.md)                              | The execution boundary every tool call is held to            |
| [ADR-0048](../../docs/adr/0048-accounts-are-clerks-and-the-worker-decides-who-is-asking.md) | The grant, and where private metadata is read                |
| [Hosting](../../docs/hosting.md#the-private-planetarium-guide)                              | The two routes, Workers Logs, previews                       |
| [The guide's scripts](../../scripts/tour/README.md)                                         | The probes, the harness verbs, the conversation replay       |
| [Roadmap](../../docs/roadmap.md#the-guide)                                                  | What was already open: the listen, the cheaper backend       |

**Where the figures come from.** The one recording of a real conversation in
the shape the replay script reads is the in-page recorder's dump of 14 Sep
2026 (`.scratch/guide-live/session-2026-09-14T05-41-04-296Z.json` in the main
checkout, 776 KB, ten minutes, Marin over Astra); every event count below is
from it. Provider facts are OpenAI's reference, changelog and model pages as
read on 7 Nov 2026, and are dated. Platform facts are Cloudflare's docs as
read the same day. The review in §3 is this spike's own reading plus a
council of five reviewers from five providers (§7); a finding names how many
seats raised it.

---

## 1. What the tree does today

One conversation, three parties. GPT Live (`gpt-live-1`) listens and speaks.
Every request that needs the scene or reasoning is delegated to GPT-6 Astra
(`gpt-6-astra`, `reasoning.effort: low`, `service_tier: priority`,
`parallel_tool_calls: true`, 2,000 output tokens), which holds the fourteen
tools in `packages/protocol/src/guideTools.ts`. The browser owns the WebRTC
peer connection and the `oai-events` data channel, executes every tool against
the observatory (`executor.ts`), answers it, and continues the response
(`loop.ts`). The Worker's one provider call creates the session from the
browser's SDP offer (`openaiLive.ts`); it holds the key and the grant check
and sees nothing of the conversation. `store: false`, so the provider keeps
no recording either. A beat ends when the remote track has been loud since
the chain closed and then quiet for 2.5 s (`clock.ts`), because the provider
has no event for the end of spoken output.

What the browser already holds and nobody keeps: every data-channel event
both ways (`runtime.ts` `#record`, a 200-entry ring behind
`ir.guideTrace(true)`), the remote-track level every 100 ms, and the usage the
provider reports per response and per session. The recording the replay
script reads (`scripts/tour/replay.mjs`) is exactly that, dumped by a scratch
recorder that is not committed.

---

## 2. What the provider changed since 14 Sep

Confirmed against the page named; an inference says so.

| Date    | Change                                                                                                                                                                                                                                                                                                                                                                                                        | What it means here                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —       | **Still no end-of-playback event.** The [migration guide](https://developers.openai.com/api/docs/guides/live-migration) says so in as many words; OpenAI support repeated it on 31 Oct; the [voice-agent evaluation cookbook](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation) infers turn completion from a quiet tail, as the clock does                                       | The remote-track clock stays. `session.output_transcript.delta` and `session.input_transcript.delta` carry `start_ms` / `end_ms` on the session timeline ([sideband reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket)); the last output delta's `end_ms` is a server-side bound on where speech content ends and can corroborate the 2.5 s verdict. It is not a played-out signal |
| 22 Sep  | GPT-6 Sol and GPT-6 Luna ($0.10 / $0.01 cached / $0.50 per million tokens); the [delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) names Luna as the starting point and Sol for complex work, and does not name Astra                                                                                                                                                          | Two cheaper backends the tree has never heard, one of them a hundredth of Astra's price                                                                                                                                                                                                                                                                                                                                   |
| 29 Sep  | GPT-6.1 Sol ($2 / $0.10 / $10, effort `low` to `max`)                                                                                                                                                                                                                                                                                                                                                         | A third                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 26 Oct  | **GPT-6.1 Terra** ($1 / $0.05 / $5), which accepts `reasoning.effort: none`, the setting the [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) recommends for "latency-critical tasks, including voice"                                                                                                                                                                              | The pacing candidate beside Luna. Astra costs $10 / $1 / $50 and cannot go below `low`                                                                                                                                                                                                                                                                                                                                    |
| 30 Jul  | `service_tier: priority` is renamed **Fast** (2× the token price); both spellings are accepted ([fast mode](https://developers.openai.com/api/docs/guides/fast-mode))                                                                                                                                                                                                                                         | The recording settles whether delegation honors it: every `response.completed` carries `"service_tier": "fast"`. The guide pays double for every backend token today                                                                                                                                                                                                                                                      |
| 16 Oct  | Nine new voices (Nuri, Juni, Flitz, Brise, Sillage, Nira, Harema, Shida, Noeul) and prompt-to-voice ([custom voices](https://developers.openai.com/api/docs/guides/custom-voices)); the [session-create reference](https://developers.openai.com/api/reference/resources/live/methods/create) enumerates 31 names, every one of `GUIDE_VOICES` among them                                                     | A listen decides which of the twenty the panel does not offer join it                                                                                                                                                                                                                                                                                                                                                     |
| 15 Oct  | GPT-Live-1.1 in ChatGPT and Codex ("less 'checking…'", better delegation); API "coming soon", no id as of 7 Nov                                                                                                                                                                                                                                                                                               | The fillers the clock has to wait out may shrink. Nothing to do until an id exists                                                                                                                                                                                                                                                                                                                                        |
| —       | Delegation config: `acknowledgement_delay_ms` 0–800, default 0 outside Decisions sessions; `reasoning.effort` adds `none` / `minimal`; `service_tier` adds `ultrafast`; `delegation.type: decisions` and `session.triggers` (15 Oct) ([reference](https://developers.openai.com/api/reference/resources/live))                                                                                                | At 0 the voice acknowledges a delegation at once, which is the filler the clock waits out; a delay near the backend's usual first token would skip it on fast turns (inference, to be measured)                                                                                                                                                                                                                           |
| —       | `store: true` keeps a **stereo WAV** (input left, output right) for 30 days, read with `GET /v1/live/sessions/{id}/content`; no delete; off under ZDR. **No transcript endpoint, export or webhook**; the [server-controls guide](https://developers.openai.com/api/docs/guides/voice-server-controls) says to persist transcripts in your own app                                                            | `store` buys audio, not text. The transcript is ours to keep (§4)                                                                                                                                                                                                                                                                                                                                                         |
| 20 Oct  | Prompt caching with a 12-hour TTL (`prompt_cache_options.ttl`) for Responses                                                                                                                                                                                                                                                                                                                                  | Not in the `delegation.responses` field list as read. The recording shows the first response writing 3,303 cache tokens; whether later ones hit is a figure the transcripts will give                                                                                                                                                                                                                                     |
| 1 Oct   | **`gpt-4o-mini-tts` shuts down 6 Jan 2027** ([deprecations](https://developers.openai.com/api/docs/deprecations))                                                                                                                                                                                                                                                                                             | Production never calls it. `scripts/tour/live-probe/lib.mjs` `clip()` does, for the synthetic visitor; the probe needs another TTS before January                                                                                                                                                                                                                                                                         |
| —       | Session limits: 128k context with background summarization past 90 %; `session.usage.updated` carries `context_window.usage_ratio` (0.015 at 15 s in the recording); no published maximum WebRTC duration, only `expires_at` and `reason: expired`                                                                                                                                                            | The loop reads `usage.seconds` from that event and drops the ratio. A long tour can learn it is about to be summarized                                                                                                                                                                                                                                                                                                    |
| Sep–Nov | Field reports: delegation that never fires (voice says "I'll do that", no `session.delegation.created`; one poster measured 13 of 14 misses; staff recommend trigger phrases in the voice prompt); a tool run that returned output while the voice stayed silent, 1 of 8; median last word to first sound 2.1 s → 2.5–2.8 s since 20 Oct on WebSocket, no regression reported on WebRTC with 6.1 Sol at `low` | Three measurements the transcripts of §4 make possible here, and one reason the loop needs a watchdog (§3)                                                                                                                                                                                                                                                                                                                |

One premise of ADR-0042 is half true. Cloudflare issues no Version URLs for
a Worker that implements a Durable Object, but the branch
[Previews](https://developers.cloudflare.com/workers/previews/resources/)
that `cf previews deploy` makes "automatically get a new Durable Object
namespace and storage". A Durable Object costs the version URL, not the
preview. Nothing here needs one anyway (§4), but the sentence in the ADR and
in `cloudflare.config.ts` should say which URL it means.

---

## 3. What the review found

The suites pass (70 browser tests, 19 Worker tests) and every seat said so;
every finding below is a path the fake cannot produce. Each names the file
and line as of `85152217`, the scenario, the fix, and how many of the five
seats raised it independently; "confirmed" means this spike read the code
path and agrees, "reproduced" means a seat ran it in memory. Ranked by what
it costs a visitor.

### The loop cannot recover

Findings 1 to 4 landed: the loop keys a call to its own delegation, closes a
chain the provider abandons, ends one on a failed response, re-prompts once
for a terminal response cut off at the token cap, prunes only finished work,
and reports a send it cannot make. The rules are in
[ADR-0042](../../docs/adr/0042-the-guide-speaks-in-one-voice.md) under "the
loop bounds its own work", and the numbers are kept here only by reference.

### The tour stops pacing itself

5. **A linger that ends while the visitor is speaking is lost, and a pause
   strands the stop.** `runtime.ts:660-661` sets `#linger` to null and then
   calls `loop.prompt`, whose refusal — the visitor is speaking, or a chain
   is open — is discarded; the quiet block is queued as state and nothing
   ever starts the response, so the tour stops until the visitor says
   something, and when they do, the backend reads "continue the tour" inside
   their question. Pause has the same shape: `pause()` cancels the linger
   (and, pressed after `linger` returns but before the words are spoken,
   throws away a beat the voice finishes behind the mute), and `resume()`
   sends the voice an instruction to "continue from where things were" that
   the voice cannot act on without a delegation, so a paused tour never
   continues on its own (reproduced, zero responses after resume). Fix:
   keep a pending continuation until `start()` accepts it, the way the
   deferred arrival already is; hold an explicit paused beat; on resume,
   prompt the backend from a fresh scene when a tour was running. (Two
   seats; confirmed.)
6. **A silent meter is permission to advance.** `media.ts:268-287` binds the
   analyser once, to the first remote stream, swallows a failed
   `context.resume()` and never reads `context.state` again; a suspended
   context or a replaced track reads exact zero. `clock.ts:90-106` then
   resolves every beat `silent` at the 8 s start timeout and
   `runtime.ts:644-653` starts the quiet count — while the narration is
   still playing. Nothing on the panel or in `ir.guideStatus` says why the
   tour is dragging. Beside it, the meter's 2,048-sample window at 48 kHz is
   43 ms read every 100 ms, so it sees 43 % of the audio; `fftSize: 8192`
   covers the interval at no cost. Fix: tell "quiet" from "no measurement"
   (context state, track `readyState`, a stuck-at-zero watchdog), rebind on
   every new track, hold automatic advancement while the meter is
   unhealthy, report the health in diagnostics. (Four seats.)
7. **The filler's tail can be the beat.** `runtime.ts:644` arms
   `waitForBeat({ since: now })` at the tick the chain closes, and
   `clock.ts:102` starts with `spoke = lastLoudAt >= since`. Live's
   acknowledgment ("let me check…") is often still sounding when
   `response.completed` arrives; one overlapping sample makes `spoke` true
   at once, the filler ends, the narration begins 2.6 s later, the beat
   settles `spoken` on the gap, the linger runs, and the quiet prompt fires
   while the words are still being spoken, so the next `go_to` cuts them
   off. The recordings did not show it and nothing guards it. Fix: require
   at least one sub-floor sample after `since` before a loud sample counts
   as the beat's speech. (One seat and this spike.)
8. **An arrival has no failure deadline.** `executor.ts:288-305` clears
   `#pending` only on arrival, a target mismatch, a takeover, a cancel or a
   new move, and `ready()` can stay false for good — a texture set that
   never finishes loading, a model that fails. Scenario: "Moving to X"
   indefinitely, the backend told `moving` and never told otherwise, no
   linger ever started. ADR-0041's "never a timer" is about the arrival
   signal, not about reporting a failure. Fix: a 45 s deadline that clears
   the pending move, holds the camera, and queues "The camera did not arrive
   at X" as a developer note. (Two seats.)
9. **A lens change announces a takeover the executor never hears, and a
   takeover tells the models in the wrong order.** `browser.ts:104`
   subscribes the lens preference to the runtime's takeover callback;
   `runtime.ts` `#takeover` cancels the loop's pending calls and tells both
   models the visitor has the camera, but `executor.cancel()` is not called,
   so the pending arrival and the owned motion stay: the visitor changes the
   lens during a guide move, "You have the camera" appears, the move lands,
   the arrival is published, and the narration restarts. In the same
   method `cancelPending` runs before the takeover block is queued, so the
   continuation it can trigger through `loop.ts:414` reads only "canceled"
   and gets the view a response later. Fix: route every takeover through the
   executor's cancellation, and queue the block before canceling. (Two
   seats; confirmed.)

### The transport dies in ways the runtime does not see

10. **ICE `disconnected` is terminal.** `media.ts:185-188` fails the session
    on `disconnected` exactly as on `failed`. `disconnected` is the state
    WebRTC uses for a transient loss that routinely returns to `connected`
    within seconds — a Wi-Fi roam, a lid cycle, a few lost packets — and it
    ends the conversation, releases the microphone, and asks for a new
    Start, a new greeting and a lost context. Fix: a grace timer (8–10 s)
    on `disconnected`, `restartIce()` once inside it, a "reconnecting"
    status, failure on `failed`, `closed`, or expiry. (Five seats and this
    spike; confirmed.)
11. **Nothing listens to the data channel itself.** `media.ts:145-197`
    handles the channel's `message` and the peer's `connectionstatechange`
    and not the channel's `close` or `error`. Scenario: the provider closes
    the channel while the peer stays connected; `send` throws from then on,
    the failure handler never fires, and the verbs that do not swallow —
    `note`, `answer`, `respond`, `ask` — throw out of `#tick` every 100 ms
    while the panel says "Listening". Fix: route `close` and `error` to the
    failure handler; guard `#tick`. (Two seats; confirmed.)
12. **The microphone can vanish unnoticed, and a resume says "Listening"
    early.** No capture track has an `ended` listener and nothing watches
    `devicechange`, so an unplugged headset leaves the sender holding a dead
    track and the guide deaf with no message; a rejected `audio.play()`
    fails the whole session where a retry on the next gesture would do;
    `runtime.ts:423-427` unmutes the provider's input and reports Listening
    before `getUserMedia` settles, and a refusal there restores the
    microphone's internal mute while `ir.guideStatus` reports it `active`.
    Fix: `ended` listeners that re-capture through `#resumeCapture` or
    report; await the capture before the provider unmute; a resuming and a
    failed state the status follows. (Four seats.)
13. **Page hide stops the transport and not the runtime.** `runtime.ts:390-393`
    closes the channel and stops the connection; the runtime stays
    "connected" over a dead transport, and a page restored from the
    back-forward cache offers Pause and Resume against nothing. Chromium
    refuses the cache to a page with an open peer connection, so the
    scenario needs another browser; the fix is a line, so it is cheap to
    close: run the failure path on `pagehide`. (Three seats; confirmed.)
14. **A message over 65,536 bytes is dropped in silence.** `media.ts:150-154`
    returns on an oversized frame; a function call whose arguments cross the
    bound is a call the loop never learns of, and its chain hangs. Fix: fail
    loudly through the failure handler, or answer the call as too large if
    its id can be read. (One seat; confirmed.)

### A long session grows

15. **Pause and resume leave permanent instructions, and the scene piles
    up.** `session.instructions.append` is for the life of the session, so
    `runtime.ts:415` and `:426` leave a contradictory pair behind every
    pause and `runtime.ts:396` leaves "Introduce yourself as Marin… Speak
    first." in the prompt for two hours; every settled view change queues a
    1.2 KB developer block and a thinking append; pause cancels the executor
    but not the loop's pending calls, which keep answering "paused"
    rejections and billing; and the loop drops the
    `context_window.usage_ratio` the usage event carries beside the seconds
    it keeps (`loop.ts:239-253`), so nothing knows a two-hour tour is about
    to be summarized. Fix: the greeting as a commentary cue alone, pause and
    resume as commentary or thinking appends; `cancelPending` on pause; keep
    the ratio in diagnostics and warn past 0.8. (Four seats and this spike;
    confirmed.)
16. **Two parallel searches cancel each other, and a superseded move drops
    its arrival in silence.** `executor.ts:786-791` holds one `#search`, so
    the second of two `find_worlds` calls in one response — habitable worlds
    beside ringed worlds, which `parallel_tool_calls: true` invites — kills
    the first with "interrupted". `executor.ts:399-404` drops a pending move
    whose target has changed without telling the backend that was promised
    an arrival. No tool has a deadline. Fix: a handle per search, or "one
    `find_worlds` per turn" in the prompt; a "move superseded" note; a bound
    on tool execution (ADR-0041 had 25 s). (Three seats; confirmed.)

### What bounds the spend

17. **Six creations a minute is not a ceiling.** `routes.ts:107-111` and the
    `GUIDE_SESSION_LIMIT` binding are the only server-side bound; usage is
    counted in the browser and enforced nowhere; the session runs at the
    Fast tier until the provider's expiry; nothing bounds concurrency or the
    `response.create` events a modified client can issue inside one long
    session. A granted token in a script opens six sessions a minute, each
    good for hours — 360 in the first hour, at roughly $3 of voice per
    session-hour — and the project's spending limit, shared by every alpha
    visitor, is the one brake, so reaching it is a denial of service for all
    of them. ADR-0042's "own session" blast radius understates a shared
    budget. Fix: two creations a minute and a per-account daily counter in a
    KV or D1 binding (neither is a Durable Object); a client-side usage
    ceiling that ends a session as a courtesy; an alert on project spend.
    (Four seats.)
18. **The browser's words wear a developer's role.** `openaiLive.ts:146-152`
    places the opening scene as a developer message, and the allow list
    admits instruction appends, so a modified client can redirect its own
    voice; omitting `session.update` protects the configuration, not the
    prompt. The blast radius is still one account's session on a limited
    project, and the executor keeps every movement bounded whatever either
    model is told; a visitor's own prompt-injection surface is small because
    no visitor-authored text enters a tool output. The fix is to say exactly
    that in ADR-0042, keep the scene short and name-only as it is, and treat
    every browser report — usage, transcript, scene — as untrusted. (Three
    seats.)

### The panel

19. **The conversation is voice-only in both directions, and the code is
    not.** `GuideControls.tsx:54-111` shows no caption though the output
    and input transcript deltas already arrive (`loop.ts:231-234` keeps a
    timestamp and drops the words); the typed path `runtime.ask()` is
    reachable only from the console; the voice picker's `aria-label` sits on
    a plain `div` and the chosen voice is conveyed by color alone
    (`hud/Action.tsx:73-87` has no `aria-pressed`); the microphone disclosure
    sits below Start with nothing tying them. A deaf visitor gets nothing; a
    visitor who cannot speak cannot ask; a screen reader hears eleven
    identical buttons. Fix: a caption line under `role="status"`, a text
    field wired to `ask`, a `radiogroup` with `aria-checked`,
    `aria-describedby` from Start to the disclosure. (Five seats and this
    spike.)
20. **Four small ones.** A network `TypeError` reaches the panel as "Failed
    to fetch" (`runtime.ts:753-757`). The mute is not awaited for its
    `muted` acknowledgment (`channel.ts:138-149`), which the docs ask for
    and the local track replacement makes safe anyway. A failure during
    `start()` does not bump the generation (`runtime.ts:496`), so `accept`
    throws on the stopped connection and "The voice connection was
    interrupted" is overwritten with "The guide has ended." And `pause()`
    while connecting is a no-op because `#connected()` is false, so a tab
    hidden during connection is never paused. (One seat each.)

### What the fake cannot say

21. `liveFake.ts` plays the loop's adversarial modes — a refused client
    event, a failed or incomplete response, an item before its creation or
    after its completion, a duplicate completion — and the loop tests hold
    them. What it still cannot say: `media.test.ts` never exercises the mute
    and the silent carrier, the `track` handler, `connectionstatechange`, an
    oversized frame or an autoplay refusal (jsdom has no `AudioContext`, so
    these need a small host fake), and `GuideControls` has no render test.
    Every fix above needs its adversarial mode in a fake first, and the test
    that proves recovery. (Four seats.)

### Checked, and not a defect

- **The voice list is current.** One seat read the conversations guide's
  table of "additional voice options" and found cedar, sage and coral
  missing; the session-create reference (read 7 Nov) enumerates 31 names
  including all eleven in `GUIDE_VOICES`, and the table omits marin too.
- **There is no output-audio event on the data channel to prefer over the
  meter.** One seat asked whether GPT Live carries the legacy Realtime
  API's `output_audio_buffer.stopped`; the recording, taken with
  `allowed_server_events: 'all'`, holds 903 server events of 19 types and
  none of them names output audio.
- **The visitor-speaking guard is sound.** `loop.ts` derives it from
  `session.input_transcript.delta` arrival times, which would fail if the
  transcript arrived after the utterance; the recording shows 51 deltas
  arriving a word at a time at about 200 ms cadence while the visitor
  speaks.
- **The continuation rule matches the documented one**: every output, then
  `response.create`; a missing output is `tool_outputs_required`.
- The decoder and executor boundary — exact key sets, bounds in the
  decoders, names never addresses, one camera move per response, a
  revision checked before every receipt — and the Worker's route — origin
  check on the mutation, exact-field record, bounded body, decoders on both
  sides, provider refusals reduced to a code and a request id, the limiter
  before the provider call — drew praise from every seat, and nothing here
  touches them.

---

## 4. Transcripts, for the visitors who ask

### The shape

The browser is the one party that sees the whole conversation, so the
browser records it. The recorder is the hook `#record` already is, moved to
the channel and media boundary so it sees every send and receive, with two
changes: it keeps the output transcript deltas the trace drops today (joined
per response, with their `start_ms` / `end_ms`), and it feeds a sink that
batches entries and posts them to the Worker. One session is a sequence of
batches, each numbered: every five seconds or 64 KB while connected, once on
`session.closed`, and once on `pagehide` as a `keepalive` request under 64 KB
(the browser's limit on a keepalive body; the recorder flushes before it gets
near, and a hard tab kill still loses the tail, which the record says). A
batch is the recording shape `replay.mjs` reads today — `wire` rows
`{t, dir, event}`, `levels` rows `[t, rms, peak]`, `notes`, `states` — so the
replay runs on a production session unchanged, and audio never appears: the
data channel carries none.

The Worker gets a third route, `POST /api/tour/sessions/{id}/events`, behind
the same origin and account checks as session creation and two more: the
session belongs to the account, and the account has opted in (below). It
writes the batch to **D1** — the binding `cloudflare.config.ts` already
reserves for H-2 — as rows of a `batches` table (`session_id, user_id, seq,
payload`) and keeps one `sessions` row per session (`user_id, voice,
prompt_version, backend_model, service_tier, build, started_at, ended_at,
close_reason, complete, voice_seconds, responses, input_tokens,
cached_tokens, output_tokens`). At ingest it also writes one `tool_calls`
row per call it finds (`session_id, seq, name, status, ms`), because "which
tools are refused" and "how long does a move take" are the questions asked
most and should not need JSON functions over payloads. The limits fit: a
200 KB session is a few dozen batches, D1 takes 2 MB per row, 100 KB per
statement and a `batch()` as one query, and every insert is idempotent on
`(session_id, seq)`. Reading a session back is a `SELECT … ORDER BY seq`
whose payloads concatenate into the document the replay script reads;
`scripts/tour/export.mjs` does that stitch and says when the session is
incomplete. The aggregate questions — refusals by tool, beat lengths,
delegations that never fired, the cache hit rate, cost per session — are
SQL. No Durable Object, so the version URLs stay. The Worker now sees
conversation content, which ADR-0042 says it never does; the phase that lands
this amends that sentence.

Why not the alternatives, each measured against the same constraints:

- **A Durable Object on the sideband.** OpenAI's
  `wss://api.openai.com/v1/live/sessions/{id}/attach` delivers both
  transcripts with millisecond ranges, the delegation events and the usage
  to a server, without touching media. It is the honest server-side record,
  and it is the server-in-the-middle ADR-0042 removed: an outbound socket
  keeps the object awake for the session (no hibernation for outbound
  sockets), the class costs the version URLs, it misses whatever happened
  before it attached, and it never sees the two things only the browser has
  — the level samples and the executor's arrivals, which are what the
  replay checks. Worth a second look only if a browser is ever found
  withholding batches, which an opted-in alpha visitor has no reason to do.
- **AI Gateway.** Its realtime support is a WebSocket proxy
  (`wss://gateway.ai.cloudflare.com/v1/…/openai`); the conversation here is a
  WebRTC data channel the gateway never terminates. At most it could log the
  one session-creation POST, which holds the configuration and an SDP and no
  words. Its own logs cap at 256 KB and seven days.
- **Workers Logs or Logpush.** 256 KB per log, seven days of retention,
  16,384 characters per Logpush event, and no logs at all for version URLs.
  They stay what they are: the record of refusals and provider failures,
  and no transcript content ever enters them.
- **Pipelines, Iceberg and R2 SQL.** Three products and minutes of batch
  latency for a hundred sessions a month; R2 SQL reads Parquet and Iceberg,
  not JSON, so raw JSONL in R2 has no query engine without it.
- **R2 for the finished document.** Three seats wanted the stitched replay
  document written to a private R2 prefix at close, beside the D1 rows. It
  is a second store, a second deletion path and a second thing the media
  allow-list must never reach, for a document a `SELECT` produces in one
  call at this volume. An R2 export under a lifecycle rule is an archive to
  add when the rows outgrow D1's 10 GB, not before.
- **`store: true` at the provider.** Thirty days of stereo audio with a
  download endpoint and no delete. It is the one way to keep what the
  visitor and the guide actually sounded like, and it is a heavier consent
  than text. A separate, later switch, if a listen ever needs the audio of
  a reported defect.

### Consent

The opt-in is a row the Worker owns: `consent(user_id, transcripts, version,
at)` in the same D1 database, written by `PUT /api/tour/transcripts` behind
the origin and account checks, read by the events route on every batch —
not at session creation alone, so an opt-out mid-session refuses the next
batch, and not through the minute-long metadata cache the grant uses, which
would record for up to a minute after a visitor said stop. Default off.
`admin` grants every feature and grants no consent. The verdict route
carries the current state so the panel renders the switch from the Worker's
answer and never from a browser flag; the row is deleted with the account's
rows, so the consent and the data have one deletion path.

Two seats preferred Clerk metadata for the flag, written by the Worker with
the secret key: private metadata the browser cannot read, or public metadata
it can read and not write. Both are honest homes, and both put a Clerk call
or a cache between a visitor's "stop" and the Worker's next write; the row
is strongly consistent, costs no call per batch, and leaves Clerk holding
grants alone. `unsafeMetadata` is browser-writable, which is the tampering
the requirement rules out, and a long-lived signed claim outlives a
revocation.

The disclosure under the controls becomes two sentences, and the switch sits
above Start: "Save this session's transcript, tool activity and timing to
improve the guide. Audio is not saved." with the retention period, who can
read it (the maintainer, from the account's dashboard), and the deletion
control; a "Recording" indicator stays on the panel while a consented session
runs. Turning the switch off deletes the account's rows; the page says that
D1's Time Travel keeps a copy for thirty days after that, because it does and
it cannot be disabled.

`localStorage` is not where the preference lives (invariant 34 is about where
`localStorage` is called, and this is not a `localStorage` preference at all):
it is account state, read from the account. The voice preference stays local
because it is a taste, not a consent.

What the record is for, and is not: product analysis, prompt tuning, the
replay and the comparison of §5. It is browser-authored, so a buggy or
tampered client can send a truncated or invented transcript the Worker can
bound but not verify; it is never billing, never moderation evidence, and
never an instruction to anything — every row stays data, as every tool
output does today.

### Retention and residency

A weekly cron deletes `batches` and `tool_calls` older than 90 days and
`sessions` older than a year; the `sessions` row outlives its batches because
the aggregate questions need the counts, not the words. The database is
created with a jurisdiction (`us`), because a jurisdiction cannot be added to
a D1 database later, and the account's one R2 bucket has none. D1 encrypts
at rest with AES-256-GCM; reads go through `wrangler d1` with account
authentication and through the export script, and no route serves a
transcript to a browser.

---

## 5. Which model thinks, and how fast

The roadmap already owes "a cheaper backend" and names the browser's usage
display as the judge. The transcripts of §4 are what make the comparison a
measurement rather than a listen:

- **Four backends, one week each, same prompts.** Astra at `low` (today),
  GPT-6 Luna at `low` (OpenAI's named starting point, a hundredth of the
  price), GPT-6.1 Sol at `low`, GPT-6.1 Terra at `none`. Per session, from
  the rows: last word to first sound (the `end_ms` of the last input delta to
  the first loud sample), delegation misses (an utterance the voice answered
  "I'll do that" to with no `session.delegation.created` within 3 s), tool
  calls refused by the decoder or the executor, beats that ended on the
  start timeout, multi-stop sequences that kept their order, cache hit rate,
  and cost from the usage columns. A cheaper backend wins if its miss,
  refusal and sequencing rates are within noise of Astra's; one seat expects
  `none` to cost multi-stop sequencing and calls that a guess, which is what
  the rows are for.
- **Fast tier against default.** The same numbers with `service_tier` left
  out. The beat is browser-paced now, so a slower first token costs the
  visitor only the filler; the tier doubles every backend token.
- **`acknowledgement_delay_ms`.** From 0 toward the backend's typical first
  token: fewer fillers for the clock to wait out on fast turns, measured as
  filler seconds per delegation from the levels.
- **The voice list.** A listen over the twenty voices the panel does not
  offer, with the same three requests the scripts README names and the
  longest intra-utterance gap recorded per voice: the 2.5 s quiet interval
  came from four conversations in few voices, and a slower voice whose
  sentence gaps exceed it is cut off by its own clock. A voice joins
  `GUIDE_VOICES` when it passes the listen and its gaps fit the interval, or
  the interval becomes per voice.
- **GPT-Live-1.1** when the API has an id: the same measurements again.

Nothing in this section changes `prompts.ts` until the first week's numbers
are in; the one exception is the delegation-miss policy, which the staff
reply recommends adding to the voice prompt as trigger phrases, and which
goes in as soon as the transcripts show a miss.

---

## 6. Phases

Each phase is a pull request, verified before the next begins, and the order
is the order the council gave: a recorder that rides a loop which can wedge
records the wedge, and a model comparison over sessions that stop pacing
themselves measures the stall.

| Phase | Lands                                                                                                                                                                                                                                                                                                                        | Done when                                                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | **The tour keeps pacing.** Findings 5–9: a pending continuation held until accepted, a paused beat and a resume that prompts, a meter that knows it is unhealthy and sees the whole interval, a sub-floor sample before a beat's speech counts, an arrival deadline, a takeover that reaches the executor in the right order | Runtime tests for the lost linger, the paused tour, the dead meter, the filler overlap, the stuck arrival and the lens takeover; one listen with the window on screen confirms a tour still beats                                                                        |
| 2     | **The transport survives.** Findings 10–14: a grace period on `disconnected`, the channel's own `close` and `error`, the microphone's `ended`, a resume whose status follows the capture, teardown on `pagehide`, a loud oversized frame                                                                                     | A test per path on a small host fake for `media.ts`; a drive-rig session that drops the network for five seconds and keeps the conversation                                                                                                                              |
| 3     | **Consent and the recorder** (§4): the D1 binding and its four tables, the consent route and the events route, the panel's switch and disclosure, the recorder at the channel boundary, the export script, the weekly sweep; ADR-0042's "sees nothing of the conversation" amended                                           | A session opted in replays through `scripts/tour/replay.mjs` from the export; a session opted out writes no row; an opt-out mid-session refuses the next batch; the Worker tests cover the consent check without Clerk; `tool_calls` answers the refusal question in SQL |
| 4     | **The bounds** — findings 15–18: a daily per-account limiter, a client usage ceiling, `cancelPending` on pause, a greeting and a pause that do not accumulate, the context ratio in diagnostics, one search handle per call, a note for a superseded move, the ADR's sentence on what the allow list protects                | Worker tests for the limiter; loop tests for the pause and the parallel searches; a two-hour drive-rig session whose usage ratio is read from `ir.guideStatus`                                                                                                           |
| 5     | **The panel** — findings 19 and 20: captions from the deltas, a typed request field, a radiogroup for the voices, the disclosure tied to Start, a sentence for a network error, the four small ones                                                                                                                          | An axe pass on the panel; a screen reader names the chosen voice; a typed request runs a tour with the microphone muted; a render test for `GuideControls`                                                                                                               |
| 6     | **The comparison** (§5): a week each of Astra `low`, Luna `low`, GPT-6.1 Sol `low`, GPT-6.1 Terra `none`; then the Fast tier against default; then `acknowledgement_delay_ms`; the voices auditioned                                                                                                                         | The measures of §5 as SQL over phase 3's rows, in a table on this page or its ADR, with the operating point named; a backend changes only on a measured win; `GUIDE_VOICES` grows only by voices that passed the listen                                                  |

Phase 3 needs none of 1–2 to compile and both to be worth reading; phases
1 and 2 are each a day, and the council's first three recommendations agree
on their order. Phase 0, the loop, is landed. A fresh council round reviews each phase's pull
request, not this page.

---

## 7. The council

Five reviewers from five providers read the same brief against `85152217`,
read-only, at each harness's highest reasoning setting, with no sight of
each other's words or of this spike's own notes: Claude Fable 5.1 (Claude
Code), GPT-6.1 Sol (Codex), Muse Wonder Full 1.0 (Muse Code), GLM 5.3 Prime
and Kimi K3.1 Pro (OpenCode over OpenRouter). Every seat ran the two tour
suites and saw them pass; none ran a provider session, a listen, a browser,
or the full gate, and each said so.

| Seat                 | Round 1 |
| -------------------- | ------- |
| Claude Fable 5.1     | 7/10    |
| GPT-6.1 Sol          | 7/10    |
| Muse Wonder Full 1.0 | 7/10    |
| GLM 5.3 Prime        | 8/10    |
| Kimi K3.1 Pro        | 7/10    |

Where they agreed, unprompted: the execution boundary and the Worker route
are the strength; the loop's recovery, the transport's transient states and
the growth of a long session are where a visitor meets a defect the fake
cannot show; option A for transcripts, with the browser as the only complete
witness; `store: false`, `parallel_tool_calls: true`, `reasoning.effort:
low` and the RMS clock all stay; and the first three things to do are the
loop, the transport and the bounds, with the recorder after them.

Where they split, and what this page decides:

- **The consent's home.** Three seats: a Worker-owned D1 row. Two seats:
  Clerk metadata written by the Worker, one private and one public. The row
  (§4), for the revocation latency and the single deletion path.
- **The store.** One seat: D1 alone. Three seats: D1 rows plus the stitched
  replay document in a private R2 prefix. One seat: R2 alone with D1 later.
  D1 alone (§4), with the export script producing the document.
- **The Fast tier.** One seat: the right trade for a voice loop while the
  budget allows. Three seats: measure before paying double on every beat.
  Measure (§5); the recording already proves delegation honors the tier.
- **The backend.** One seat: test Luna first, make it the default if it
  holds. One seat: Astra is "more model than a routine beat needs", judged
  by beat type. Two seats: a listening question the recordings decide. Four
  backends in the comparison (§5), one week each, decided by rows.
- **The arrival deadline.** Two seats asked for one; ADR-0041 says arrival
  is "never a timer". The ADR's sentence is about the arrival signal, and a
  deadline that reports a failure keeps it; finding 8 stands.

What was raised and declined, with the reason: a stale voice list (checked
against the reference, §3); an output-audio event to replace the meter
(none on the data channel, §3); a sideband recorder (§4); enforcing spend
through a trusted sideband (the Durable Object again; a daily limiter and a
client ceiling bound an alpha without it, §3 finding 17).
