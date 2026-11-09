# ADR-0042: The guide speaks in one voice, and the browser runs its loop

Status: accepted · 14 Sep 2026; authorization amended 29 Sep 2026 by
[ADR-0048](0048-accounts-are-clerks-and-the-worker-decides-who-is-asking.md),
where an account grant replaces the shared password; the loop's bounds
added 7 Nov 2026, the tour's pacing and the transport's survival 8 Nov 2026.
Supersedes the two-model
narration, the controlled clips, the application socket, and the Durable
Object session store of [ADR-0041](0041-the-guide-requests-the-view.md); keeps
that ADR's execution boundary.

## Context

[ADR-0041](0041-the-guide-requests-the-view.md) gave the Planetarium a guide
that proposes bounded actions the observatory executes, and it split the
guide across two models and two audio paths. GPT Live held the live voice
conversation; GPT-6 Astra was a backstage **director** that planned stops and
chose subjects; automatic tours spoke through controlled `gpt-4o-mini-tts`
clips with the `marin` voice while Live stayed muted and available for
interruptions. A server coordinator scheduled the delegated work, a `TourSession`
Durable Object held each session, a `TourAdmission` object held the alpha
allowance, and an application WebSocket carried plan updates, transcripts, and
transport commands to a controlling tab. The panel showed the ordered stops, a
narration phase, and a plan revision history.

The split could not be made smooth. Two speech sources meant a hand-off every
time the visitor interrupted an automatic tour: the clip stopped, Live took
over, and the seam was audible. A director that planned ahead and a narrator
that spoke could disagree about what was on screen, and the plan panel showed
a structure the visitor had not asked to read. The controlled clip's
completion was the only honest signal that a stop had been _heard_, which tied
narration timing to a second provider and a second voice. And the whole
apparatus — coordinator, sideband socket, two Durable Object classes — existed
to keep a server in the middle of a conversation the browser could hold
itself.

The provider offers **Responses delegation**: a managed mode in which the Live
service, given a rich tool inventory, delegates the reasoning to a backend
model and returns its results to the voice, and a WebRTC data channel over
which the browser receives the backend's tool calls and answers them. A
phase-0 probe of five real sessions established that Live voices only the
terminal response of a delegation, queues a new delegation behind one whose
tool chain has not ended, and honors a browser-authored developer message and
`response.create` — enough for the browser to be the whole middle.

## Decision

**One model talks, one model thinks, and the browser runs the tool loop over
the WebRTC data channel; the server holds the key and the decision on who may
open a session, and nothing else.** There is one conversation. GPT Live listens and speaks; every request
that needs the scene, the record, or reasoning is delegated to GPT-6 Astra,
which sees the current view, holds the tool inventory, composes a tour on the
spot, and paces it with the browser's clock. There is no director planning
backstage, no separate speech model, no authored itinerary, no plan panel, no
application socket, and no hand-off between a narrator and a director. The
controls are Start, Pause, End, and a voice picker.

The execution boundary of [ADR-0041](0041-the-guide-requests-the-view.md) is
kept whole: the observatory executes every movement, the executor validates
every argument against a versioned inventory in `packages/protocol`, arrival
is a receipt gated on the renderer's readiness and never a timer, and the view
and request revisions are checked before execution, before a receipt, and
before a tool output. Time changes go through the photographic instant; no
tool reaches world pause, time warp, or a teleport. Every message the browser
sends either model is prose it wrote itself about application state; tool
output and transcripts are data and never become an instruction.

- **A beat is a chain: tool calls first, words last, stop.** Live voices only a
  delegation's terminal response, so a stop is a short chain of tool calls
  followed by the words, and text written before a tool call is never spoken.
  A tour is a series of beats and the browser is the metronome: it prompts the
  backend with a stop's arrival receipt, waits for the words to be spoken and
  then for the seconds the backend declared with `linger`, and only then
  prompts for the next stop.

- **The clock is the remote audio track.** The provider has no event for the
  end of spoken output, and on WebRTC the speech is a media track the browser
  plays, so the browser is the one witness that can measure it. An
  `AnalyserNode` on the track reports a level; the guide is speaking above a
  floor and quiet below it. Output audio streams continuously, so the level is
  the only signal, and the clock waits for speech to _begin_ after the terminal
  response before it measures silence, because Live fills the wait for backend
  work with an acknowledgment. That acknowledgment is often still sounding
  when the terminal response lands, so a voice sounding at the last reading
  has to break once before a loud sample is the beat's; a beat that began on
  the filler's tail settled on the gap before the narration and prompted the
  next stop over it. The numbers are measured, not derived: silence
  decodes to exact zero and speech reads 0.005 to 0.2, so the floor is 0.003;
  the voice pauses up to 2.3 seconds between the sentences of one narration, so
  a beat is quiet after 2.5 seconds, counted from the last word. The analyser
  reads 8,192 samples, 171 ms at 48 kHz, so every 100 ms read overlaps the
  last; at 2,048 it heard 43 % of the audio.

- **A meter that cannot hear holds the tour; it never advances it.** Exact
  zero is what silence decodes to, and also what a suspended audio context,
  an ended track, or an analyser left on a track the provider replaced reads,
  so the connection binds every remote track, reads the context's state on
  every ask, and reports whether the level is a measurement: `ok`,
  `unmeasured`, `suspended`, `ended`, or `stuck` when the output transcript
  has flowed for 8 s with the level at exact zero throughout — the transcript
  being the one witness to the voice that does not depend on the meter. A
  beat that reads silent on a meter that is not `ok` holds the linger and
  listens again once the meter can hear; `ir.guideStatus().meter` says why a
  tour is holding.

- **The transport survives what it can, and reports what it cannot.** A peer
  that reports `disconnected` is on a 10 s grace, not over: that is the state
  WebRTC uses for a loss it expects to recover from — a Wi-Fi roam, a lid
  cycle, a burst of lost packets — and consent checks bring it back on their
  own once packets flow. No ICE restart is attempted, because that takes a
  new offer and answer and the Worker's one SDP exchange is at session
  creation. While the peer is on its grace the runtime says `reconnecting`,
  does not sample the clock, so a linger holds rather than reads the gap as
  the end of the words, and listens for an interrupted beat afresh once the
  path is back. `failed`, `closed`, the channel's own `close` or `error`, a
  frame over 65,536 characters, and the grace running out are failures,
  reported once with their reason, never a silence; a host read that throws
  under a tick ends the session the same way rather than throwing every
  100 ms. A capture track that ends on its own is re-captured from the
  default device, and when no device answers the session continues with a
  message rather than ending; a refused `audio.play()` is a message too,
  retried on the next unmute, which the panel's Resume makes under a
  gesture. A resume opens the provider's input only once the microphone is
  live — told first, the voice took the silent carrier for the visitor's
  turn — so the status says paused until then and stays paused, with the
  reason, when the capture fails. The page going away runs the failure path,
  because a page the back-forward cache restores must not find the runtime
  connected over a dead transport.

- **The browser starts backend work only while no chain is in flight and the
  visitor is quiet.** A message queued into an open chain is read by that
  chain's continuation as state, not as an instruction, so an arrival that
  lands inside an open chain is queued and prompted at the first tick after the
  chain closes, or dropped once the view has moved on. A correction releases
  the same way: a move that returns at once leaves the backend idle when the
  utterance ends, and the new delegation supersedes the pending one. Every
  other prompt the browser means to start is held the same way rather than
  queued on refusal: the quiet prompt after a linger, the resume of a tour a
  pause interrupted, the failure of a move that never arrived. Nothing reaches
  the wire until the loop can start on it, so a prompt the visitor's question
  overtakes is dropped rather than read inside the question as "continue the
  tour". A pause that interrupts a tour — a linger in any phase, a held
  prompt, a deferred arrival, a pending move, or a chain whose camera calls
  the pause refuses — is repaired on resume by prompting the backend from the
  view as it stands, because the voice is told the visitor is back and cannot
  continue a tour without a delegation. A takeover queues its block before it
  cancels the pending calls, because canceling the last one continues the
  chain, and a continuation that ran ahead of the block read only "canceled".

- **Queries run together; the camera runs one at a time.** `parallel_tool_calls`
  is enabled, and the loop executes the query tools of one response beside each
  other while serializing the camera tools and executing only the first move of
  a response — a second move in one turn is answered rejected without running,
  because a move that replaces a move still starting is a camera that thrashes.
  A response continues only once every call it made has its output.

- **The loop bounds its own work, in number and in time, because nothing else
  can close a chain the provider abandons.** "In flight" is read from the
  loop alone, and a chain that never closes is a tour that never advances. A
  `response.create` the provider refuses closes the chain when the `error`
  names the create's event id, and so does 30 s with no `response.created`;
  an open response is abandoned at 90 s. The recorded sessions answer a
  create in 168 to 972 ms and complete a response in 1.0 to 2.0 s, so both
  bounds are an order of magnitude outside the measured path. A failed
  response is never continued; a terminal response cut off at the token cap
  is re-prompted once, with a note saying so, and ended on a second cut-off;
  a code the browser cannot act on — a configuration it may not change, a
  budget that is spent — ends the session with a sentence. An item event
  carries no response id, only its envelope's delegation id, so a call is
  keyed to the newest response open under its own delegation and never to
  whichever response is open; a call that arrives before its
  `response.created` holds a provisional row the created or the completion
  adopts, and an unmatched output is never a continuation on its own. A row
  is pruned only once it is done — completed, every call answered, continued
  or terminal — and the ids of finished responses and seen calls outlive
  their rows in bounded sets, so a redelivered completion or item does
  nothing, where an unknown completion would otherwise start a billed
  response. Every send the loop makes is caught and reported, because the
  answer of one call is the serialized queue every later move waits on.

- **The server holds two things.** Authorization: only a signed-in account
  whose private metadata grants the guide can create a session — the browser
  presents its Clerk session token and the Worker reads the grant
  ([ADR-0048](0048-accounts-are-clerks-and-the-worker-decides-who-is-asking.md)).
  And the configuration: prompts, model, reasoning effort, service
  tier, voice, and the data-channel allow list are authored at session creation
  and cannot be changed by the browser, because `session.update` is not on the
  allow list. The spending bound is the provider project's limit and the
  duration bound is the provider's own session expiry; the Worker keeps no
  per-user ledger and no session timer, because a vanished client ends its own
  session within three seconds and the Worker never sees a backend usage event
  a browser could not forge anyway.

The Worker implements no Durable Object. The `tour-v2` migration deletes the
`TourSession` and `TourAdmission` classes. The two routes that remain are
`GET /api/tour/capabilities` and `POST /api/tour/sessions`;
the events socket, the `/speech` route, the close and status and usage routes,
and the controlling-tab application socket are gone.

## Alternatives considered

- **Keeping the director/narrator split and smoothing the hand-off.** The seam
  is where two speech sources meet, and no amount of cross-fading removes the
  fact that one voice stopped and another started. Responses delegation makes
  the reasoning model feed the one voice, so there is no second source to hand
  off from.

- **Keeping the controlled clips for automatic tours.** The clip's completion
  was the honest signal a stop had been heard, and that is worth preserving —
  but the remote-track level is the same signal without a second provider, a
  second voice, or a mute-and-unmute around every interruption. The clock
  measures the one voice the visitor is already hearing.

- **Keeping the server coordinator and the sideband socket.** A server in the
  middle of the conversation is a Durable Object kept active by an outbound
  socket, a reconnect lease, and a session deadline the adapter has to enforce.
  The browser already owns the WebRTC peer connection; giving it the data
  channel too removes the socket, both Durable Object classes, and the coordinator,
  and it removes the preview-URL limitation that Durable Objects imposed on
  deployed verification.

- **Letting the browser send `session.update`.** It would let a tampered
  browser switch the backend model or enable web search for the life of its
  session. The allow list omits it; the scene reaches the backend as a queued
  developer message instead, and the blast radius of a modified browser stays
  its own session's backend tokens on a spending-limited project behind an
  account grant.

## Consequences

The pure loop, executor, and clock are tested with one fake data channel
(`apps/game/src/tour/liveFake.ts`) that replays the phase-0 event shapes,
refuses an event off the allow list as the real connection does, and plays
the provider's refusals, failures and cut-offs on request, so the beat, the
correction, the deferred arrival, the held prompts, the paused tour, the
meter that cannot hear, the filler's tail, the move that never arrives, the
lens takeover, the one-move-per-turn guard, pause, end, the peer on its
grace, the resume that waits for the microphone, the page going away,
and every recovery above are covered without a provider, and a misspelled
event fails a test rather than a session. The peer connection, the data
channel, the capture tracks and the audio element are driven by a small
host fake in `media.test.ts`: the grace and its expiry, a channel the
provider drops, a track that ends on its own, a refused play, a frame too
large to read. The browser names provider events only in its adapter
— `channel.ts`, `loop.ts` and `media.ts` — and the runtime speaks in verbs
over a `send` typed on the protocol's `GuideClientEvent`. Determinism is unchanged: the executor moves only the observatory,
and headless checks preserve identical canonical hashes.

What deployed verification still needs is a real listen. The clock's numbers
and the loop's behavior are measured against recorded conversations, but
spoken delivery across voices, and whether Astra or a cheaper backend paces a
routine beat well, are judged by a person on headphones, not by a test or a
model name. Two things the recordings surfaced belong to the prompt rather
than the code and are tuned there: Live composes ahead of the arrival and must
be told to name the destination and wait, and a request about several showable
things is a tour with one stop each rather than one narration over one view.

Because the Worker implements no Durable Object, Cloudflare generates version
preview URLs for it, and deployed guide verification uses an ordinary preview
rather than a separately configured staging Worker. The
[hosting guide](../hosting.md#the-private-planetarium-guide) records the endpoints and this change.
Flight and the Survey keep their own audio direction and no performed narrator,
documented in [audio](../design/audio.md#voice) and
[world](../design/world.md#voice); the Planetarium remains the one place that
permits an expressive guide, in [Planetarium](../design/planetarium.md#the-optional-guide).
