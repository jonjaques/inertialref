# ADR-0042: The guide speaks in one voice, and the browser runs its loop

Status: accepted · 14 Sep 2026. Supersedes the two-model narration, the
controlled clips, the application socket, and the Durable Object session
store of [ADR-0041](0041-the-guide-requests-the-view.md); keeps that ADR's
execution boundary.

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
the WebRTC data channel; the server holds the key and the password and nothing
else.** There is one conversation. GPT Live listens and speaks; every request
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
  work with an acknowledgment. The numbers are measured, not derived: silence
  decodes to exact zero and speech reads 0.005 to 0.2, so the floor is 0.003;
  the voice pauses up to 2.3 seconds between the sentences of one narration, so
  a beat is quiet after 2.5 seconds, counted from the last word.

- **The browser starts backend work only while no chain is in flight and the
  visitor is quiet.** A message queued into an open chain is read by that
  chain's continuation as state, not as an instruction, so an arrival that
  lands inside an open chain is queued and prompted at the first tick after the
  chain closes, or dropped once the view has moved on. A correction releases
  the same way: a move that returns at once leaves the backend idle when the
  utterance ends, and the new delegation supersedes the pending one.

- **Queries run together; the camera runs one at a time.** `parallel_tool_calls`
  is enabled, and the loop executes the query tools of one response beside each
  other while serializing the camera tools and executing only the first move of
  a response — a second move in one turn is answered rejected without running,
  because a move that replaces a move still starting is a camera that thrashes.
  A response continues only once every call it made has its output.

- **The server holds two things.** Authorization: the shared alpha password
  issues a signed, HttpOnly cookie, and only a request carrying it can create a
  session. And the configuration: prompts, model, reasoning effort, service
  tier, voice, and the data-channel allow list are authored at session creation
  and cannot be changed by the browser, because `session.update` is not on the
  allow list. The spending bound is the provider project's limit and the
  duration bound is the provider's own session expiry; the Worker keeps no
  per-user ledger and no session timer, because a vanished client ends its own
  session within three seconds and the Worker never sees a backend usage event
  a browser could not forge anyway.

The Worker implements no Durable Object. The `tour-v2` migration deletes the
`TourSession` and `TourAdmission` classes. The three routes that remain are
`GET /api/tour/capabilities`, `POST /api/tour/login`, and `POST /api/tour/sessions`;
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
  its own session's backend tokens on a spending-limited project behind a
  password.

## Consequences

The pure loop, executor, and clock are tested with a fake data channel that
replays the phase-0 event shapes, so the beat, the correction, the deferred
arrival, the one-move-per-turn guard, pause, and end are covered without a
provider. Determinism is unchanged: the executor moves only the observatory,
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
