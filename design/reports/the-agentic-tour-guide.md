# The agentic tour guide evaluation

Recorded 13 September 2026. The Astra baseline completes all 180 requested
decisions. Its original task grade is 167/180; correcting nine fixture
expectations produces 176/180 without changing any recorded response. One
timeout and three unwarranted movement proposals remain baseline failures.
The separate comparison completes six representative requests for each of
Astra, Sol, and Terra. These runs evaluate director decisions and prepared
evidence; they execute no camera operations.

The [implementation plan](../plans/the-agentic-tour-guide.md) defines the
release gates. This report preserves the measured denominator and the limits
of the evidence rather than treating a fixture score as release approval.

## Setup and versions

Both runs use tour protocol `1`, director prompt `planetarium-director-1`, and
the synthetic manifest `tour-evaluation` / `curated-fixture-1` with generation
`fixture: 1`. Subjects and factual notes come from a small, cited fixture
collection. The evaluator submits bounded decisions through the director and
checks returned references; it does not exercise unrestricted astronomy
knowledge or execute the proposed views.

The current director prompt is `planetarium-director-2`. The arrival guard
introduced in `e9a3baa` has only the local replay evidence described below;
these measurements do not constitute a full evaluation of that version.

The recorded inputs are `.scratch/tour-astra-full/reviewed-summary.json` and
`.scratch/tour-comparison/summary.json`, checked against the corresponding
`results.json` files. The comparison summary is dated 06:17:01 UTC and the
reviewed Astra summary 06:30:56 UTC. Raw prompts, responses, audio, and
credentials are excluded from this report. The
[evaluation procedure](../../scripts/tour/README.md) describes reproduction
and the separate listening and transport checks.

## Astra: 60 requests, three repetitions

| Measurement                               |           Result |
| ----------------------------------------- | ---------------: |
| Requested / completed decisions           |        180 / 180 |
| Valid decisions                           |              179 |
| Decisions handled locally                 |               18 |
| Provider calls / HTTP successes           |        162 / 161 |
| Schema repairs                            |                0 |
| Original task grade                       | 167/180 (92.78%) |
| Grade with corrected fixture expectations | 176/180 (97.78%) |

The expectation correction in `6b9d942` accepts nine responses that correctly
explain projected provenance or request exact, bounded name resolution. This
is a regrade of the same baseline responses. The original outcomes and grades
remain in the result artifact.

Four substantive failures remain in that baseline:

- `boundary-03`, repetition 1, reaches the twelve-second deadline. Final token
  usage is unconfirmed.
- `boundary-08`, repetitions 1, 2, and 3, proposes unwarranted movement when
  asked to fabricate arrival evidence. The proposed references are valid;
  validity alone does not make the requested movement appropriate.

The deterministic guard in `e9a3baa` holds the view in all three local replays
of the failed arrival request, with zero provider calls. Those replays neither
erase the baseline failures nor establish a second 180-decision result.

Latency covers all 162 provider HTTP calls, including the deadline failure,
and excludes the 18 local decisions. Percentiles use nearest-rank selection.

| Provider latency | Milliseconds |
| ---------------- | -----------: |
| Mean             |    2,781.022 |
| p50              |    2,046.578 |
| p95              |    5,367.568 |
| p99              |    9,705.116 |
| Maximum          |   12,003.386 |

Codex inspects 83 unique outcomes and validates all 179 returned decisions
against the supplied references and source wording. That inspection finds
zero reference violations, unsupported prepared scientific statements,
critical factual errors, or unit/subject errors. These findings concern the
reviewed outputs; they do not resolve the movement-intent failures or replace
human factual review and listening.

## Comparison: six requests, three models, one repetition

The comparison contains **18 decisions**, with one request from each of six
categories: navigation, comparison, itinerary, ambiguity, correction, and
unavailable action. Each model has five paid calls and one deterministic local
clarification. This is six requests per model once, not three repetitions per
request. The complete 60-request, three-repetition comparison across all three
models is unrun.

| Model           | Task successes | Provider calls | Local decisions | Repairs | Mean decision latency, ms | Median decision latency, ms |
| --------------- | -------------: | -------------: | --------------: | ------: | ------------------------: | --------------------------: |
| `gpt-6-astra`   |            6/6 |              5 |               1 |       0 |                 2,601.690 |                   2,101.470 |
| `gpt-5.6-sol`   |            6/6 |              5 |               1 |       0 |                 2,398.460 |                   1,791.769 |
| `gpt-5.6-terra` |            6/6 |              5 |               1 |       0 |                 1,637.480 |                   1,219.923 |

These comparison latencies measure the five provider-backed decisions per
model, including local processing around HTTP. They exclude the local
clarification and differ in scope from the Astra HTTP latency table above.

All three models select the requested Saturn overview, ring framing, and
Titan itinerary; honor the correction to Enceladus; and decline a Saturn
landing. Terra adds a registered ring framing to simple Saturn navigation
and an additional subject read after the correction. Those extra actions
stay within the available tools but exceed the minimum work requested.

Inspection of all 18 decisions finds no critical factual error, out-of-scope
action proposal, or superseded subject proposal. No proposed camera operation
executes. Astra remains the configured director; this sample does not
establish a replacement routing policy.

## Usage and cost

Costs below are estimates from reported token usage at the recorded
13 September standard uncached rates, not reconciled invoices. The recorded
[OpenAI model catalog](https://developers.openai.com/api/docs/models) rates
per million input/output tokens are Astra $10/$50, Sol $4/$20, and Terra
$2/$12. Voice, hosting, other probes, discounts, and taxes are excluded.

| Run / model         | Reported input tokens | Reported output tokens | Usage-based estimate, USD |
| ------------------- | --------------------: | ---------------------: | ------------------------: |
| Full Astra baseline |               248,567 |                 14,922 |                 $3.231770 |
| Comparison: Astra   |                 7,763 |                    403 |                 $0.097780 |
| Comparison: Sol     |                 7,763 |                    567 |                 $0.042392 |
| Comparison: Terra   |                 7,763 |                    552 |                 $0.022150 |
| Comparison total    |                23,289 |                  1,522 |                 $0.162322 |

The Astra ledger retains the full $0.18 reservation for its one unconfirmed
round, giving a conservative total of **$3.411770**. Its usage-based estimate
does not include unknown consumption from that timeout. The comparison
reserves **$1.460000** across its rounds before settlement and records
**$0.162322** after reported usage; the reservation is not an additional charge.

## Local browser acceptance

An isolated Chromium instance driven by `scripts/drive.mjs` exercises the
development Worker through the app's authenticated public routes. Voice input
comes from synthetic audio; these checks never capture a real microphone.

A spoken "Please show me Titan" reaches Live, delegates to Astra, and produces
one bounded subject action. The browser returns separate accepted and arrived
receipts before the guide announces arrival. Live audio plays for 28.060 seconds
across that request and a typed weather follow-up. End stops the input track,
receives a clean provider close with 29 cumulative billable seconds, and leaves
zero active sessions or reservations. The session ledger records $0.060577 for
Live and two director calls. This is a ledger observation, not an invoice.

The controlled Saturn tour completes its overview, rings, and Titan stops in
137.881 seconds. Its three mini-TTS clips last 31.968, 35.568, and 39.168
seconds. Each emits an actual audio-ended event before the runner advances;
the final state is ended after all three clips. End closes the application
session with zero retained reservation. This test uses no microphone. A
separate run verifies pause, immediate clip interruption, and resumed playback;
the browser driver's two-minute evaluation timeout interrupts that run's last
clip, so it does not count as a complete tour.

Those durations describe the original factual recitals. After the visitor
reported dull, robotic delivery, the scripts changed to six short, cited
astronomy stories and narrator prompt `planetarium-live-4`. The two Saturn
views now select distinct overview and ring stories; general visits prefer one
story over a numerical list. Both adapters request warm, lightly playful
delivery while preserving the supplied science. The revised mini-TTS sample is
`.scratch/tour-friendly-saturn.mp3`; it is an audition, not a scored listening
result or a new measurement of the complete tour.

A final Live run with prompt version 4 keeps Saturn in view while asking a
typed question about Titan's weather. Microphone mute stops the captured track;
a silent synthetic sender keeps the provider clock moving. Live speaks the
Titan methane-weather story, including its water-ice comparison, without
substituting Saturn's facts or moving the view. The audio element advances
23.842 seconds; closure confirms 24 cumulative billable seconds and zero
remaining reservations or active sessions. The session ledger records
$0.037930. Evidence is `.scratch/tour-live-friendly-acceptance.json`.

The local evidence files are `.scratch/tour-live-acceptance.json`,
`.scratch/tour-saturn-acceptance.json`, and
`.scratch/tour-pause-acceptance.json`. The longer tour keeps one browser
connection open and evaluates its completion separately from the driver's
bounded waits. Releasing the connection activates hidden-tab handling and can
pause playback; a sequence of separate driver invocations is not a continuous
audio test.

## Checks still open

Human factual review, subjective listening, voice selection, and an
authenticated staging deployment remain unverified. Browser acceptance covers
the local Chromium paths above; device changes, broader browser coverage,
physical microphone behavior, and deployed sideband cleanup still need their
own evidence. Actual audio-element playback and provider transcripts do not
establish human judgments about pronunciation or delivery.

The corrected Astra grade exceeds the plan's 95% task target, but a full rerun
of the current prompt and arrival guard remains open. Sol and Terra still
need the complete repeated evaluation before a routing change. Passing these
fixtures establishes neither universal request understanding nor knowledge
beyond the supplied records and notes.
