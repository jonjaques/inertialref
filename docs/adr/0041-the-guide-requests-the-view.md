# ADR-0041: The guide requests the view through the observatory

Status: accepted · 13 Sep 2026. The execution boundary stands.
[ADR-0042](0042-the-guide-speaks-in-one-voice.md) supersedes the two-model
narration, the controlled clips, the application socket, and the Durable
Object session store described here; read it for the current shape of the
guide, and read this for the executor, receipts, revisions, and the bounded
inventory it keeps.

## Context

The Planetarium can explain an object and take a visitor through a short tour,
but it shares a running world with flight. Giving a model the game harness
would also give it verbs that teleport ships and change canonical time.
Generated camera scripts would create another source of camera authority.

Conversation introduces a second timing problem. A destination can change
while inference is running, and a spoken transcript can arrive before its
audio finishes. Neither a model response nor a caption proves that the camera
has arrived or that the visitor has heard a stop's narration.

## Decision

**An optional Planetarium guide proposes bounded actions; the existing
observatory executes them, and the application verifies the result before
narrating it.**

`packages/protocol` owns a versioned wire contract with strict field and size
validation. The browser returns a bounded inventory of opaque subject IDs,
registered compositions, survey sites, numeric facts, and source references.
The director chooses from those IDs. It cannot supply coordinates, JavaScript,
renderer handles, or a cinematic script. World search uses the existing worker
pool, with cancellation, an eight-light-year radius ceiling, and a result cap.

`packages/devtools` extracts quantities directly from domain records. A fact
has its quantity, unit, display wording, speech wording, provenance, and
source IDs. Missing values retain their reasons. Observer altitude, apparent
fill, arrival, and photographic time occupy a separate record. Ordinary model
context contains the current view, nearby subjects, and available actions.
Requested measurements cross as raw quantities and units; hand-written fact
blurbs, summaries, manifests, and source prose do not. The full application
context remains available for ID validation and on-demand record reads.

For observed Solar System subjects, both models can contribute established
astronomy, discovery history, and analogies from their own knowledge. Game
measurements and scene state remain authoritative. Model prose has no invented
citations and does not imply a historical event is rendered. Projected worlds
have no invented mission history. Explicit Solar System, Saturn, and developer
demo presets have separately authored scripts and sources; they are not
background context for ordinary conversation.

The local executor deduplicates operation IDs and checks the current request
revision, expected view revision, session, expiry, and allowed arguments.
Acceptance and arrival are different receipts. Explicit observatory changes
advance a mutation revision; rendered easing and photographic playback do not.
Taking over the camera revokes pending work. Holding a canceled movement stops
the presentation pose without moving the ship. Named finite orbit, push-in,
pull-back, and reveal gestures run inside the observatory's existing sample
loop while narration plays. They use bounded target-relative angles and range,
not another camera producer. Starting a gesture precedes its arrival receipt;
sampling and stopping its future frames preserve that receipt's revision.

Time commands hold `observatory.time` before changing photographic playback.
They never call simulation pause, time warp, or teleport. This applies
[ADR-0033](0033-presets-hold-a-photographic-instant.md) and the camera ownership
in [ADR-0011](0011-application-shell-and-modes.md). Hash comparisons use paused
worlds or equal canonical tick inputs; an active simulation continues while
its visitor looks elsewhere.

The Guide panel is closed by default and lazy-loaded inside the existing
Planetarium workspace. Its runtime lives outside React. Opening ordinary
pages creates no guide connection or microphone request. Starting voice is
explicit and discloses that the voice is AI-generated. Microphone mute, guide
mute, and tour pause have independent state.

The cloud adapter uses one `TourSession` Durable Object per session and a
separate `TourAdmission` object for the private alpha allowance. A shared
password issues a signed, HttpOnly cookie lasting 24 hours. Every holder of
that password shares one quota principal, including after a cookie reset.
This is an access gate for a bounded alpha, not an account system.

Sessions last at most ten minutes and have a thirty-second reconnect lease.
Admission reserves a two-dollar session allowance against a ten-dollar daily
alpha allowance. These are configured spending bounds, not measured tour
prices. Provider calls reserve their allowance before execution. Uncertain
creation or finalization keeps the reservation until the application can
settle it conservatively. Session state and usage are application records;
they do not enter simulation saves.

GPT-6 Astra is the director through Responses, with low reasoning effort,
strict structured output, at most two rounds per inference within a 25-second request deadline, an
12,000-byte request envelope, and 2,000 output tokens per round. The application
validates selected facts and actions after schema validation. Exact local
commands and explicit authored tour presets avoid inference.
Sol and Terra remain evaluation alternatives until measured results support
a routing change.

GPT Live is the conversational narrator using client delegation and WebRTC.
The server creates its configuration, attaches the sideband, and disables
browser-authored upstream data-channel controls. Only the coordinator
schedules delegated work. Transcript fragments retain provider identity and
time intervals; fragments do not execute commands. This follows the documented
[client delegation contract](https://developers.openai.com/api/docs/guides/live-delegation)
and [Live WebRTC startup](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live).

Automatic tours use controlled `gpt-4o-mini-tts` clips with the `marin` voice,
including when Live is connected. Live stays available for interruptions and
questions; its output is muted during the clip and quiet looking interval.
The sideband tells it to listen without repeating the script. Speech pauses
the runner and finite camera gesture, then makes conversational replies
audible. Exact spoken transport commands use the same client controls.

The runner advances only after the matching view arrives, its minimum viewing
time elapses, the matching clip actually ends, and any promised quiet look
finishes. Pausing freezes elapsed looking time. A transcript or an estimated
speech duration is insufficient. Manual tours still use Next. The panel shows
the ordered stops, camera intent, current narration phase, and bounded plan
revision history; a conversational edit updates that structure.

The core guide sends no images. Visual questions and composition adjustment
are deferred extensions. An image capture port, observation tickets, and image
budgets require their own implementation and acceptance.

## Alternatives considered

- Giving the narrator unrestricted tools makes camera and simulation authority
  depend on a prompt. The local allowlist and operation ledger enforce them.
- Steering every frame would add latency and another camera producer. Named
  compositions and the existing observatory solve movement locally.
- Advancing after a transcript or timer can move the camera while speech is
  still playing. Controlled clip completion provides evidence the host can test.
- Treating the shared password as independent users lets new cookies reset
  the allowance. One alpha principal keeps the bound across sessions.
- Anonymous public admission needs account, abuse, and quota decisions that
  a private alpha does not establish.

## Consequences

The same pure runner and executor can be tested with headless sessions and
provider fakes. Tests cover stale work, duplicate receipts, canceled search,
surface rejection, photographic time, and unchanged canonical hashes. They do
not establish model quality, spoken delivery, provider account access, or
deployed reliability.

Verbose tracing is an explicit host setting. It can record conversation text,
model inputs and outputs, tool receipts, and usage for diagnosis. The committed
deployment disables it. A bounded trace sink removes credentials, SDP and raw
audio; browser tracing is separately enabled through `ir.guideTrace(true)` and
retains at most 200 application messages in memory. Trace writer failures do
not affect session behavior.

An active outbound Live socket keeps its Durable Object active; inbound
socket hibernation does not remove that cost. Session deadlines and closure
are therefore part of the adapter, consistent with
[Cloudflare's WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

The Guide's Durable Object classes also affect review hosting. Cloudflare
does not generate version preview URLs for a Worker that implements Durable
Objects. Deployed acceptance needs a separately configured staging Worker;
local workerd checks remain available. The
[preview limitation](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
applies to the guide before multiplayer partition authorities exist.

The Planetarium explicitly permits an expressive guide. Flight and the Survey
retain their own audio direction, documented together in
[Planetarium](../design/planetarium.md#the-optional-guide),
[audio](../design/audio.md#voice), and [world](../design/world.md#voice).
