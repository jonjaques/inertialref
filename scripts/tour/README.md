# Tour guide evaluation

Provider calls run only when an operator invokes these scripts. CI imports
fixture data and runs fake providers without credentials or API spending.
The scripts read `.env.local` through Node's environment loader. They never
print credentials or raw provider errors.

Check model-list access with `node scripts/tour/probe.mjs --mode=models`.
This establishes account visibility, not usable voice sessions or concurrency.

Generate three controlled narration samples with
`node scripts/tour/probe.mjs --mode=speech --allow-spend`.
The output directory contains MP3 files, source notes, generation latency, and
an unfilled listening scorecard. This baseline uses `gpt-4o-mini-tts` and
`marin`. Its completion signal comes from the browser audio element.

Run a small director smoke test with
`node scripts/tour/evaluate.mjs --allow-spend --limit=3 --repetitions=1`.
For the release comparison, use all 60 requests and three repetitions for each
of `gpt-6-astra`, `gpt-5.6-sol`, and `gpt-5.6-terra`, with a separate `--out`
directory per model. The default is Astra. `--max-cost-usd=6` reserves each
round before sending and settles reported token usage, using dated standard
rates in `budget.mjs`. A missing usage report keeps its full reservation.
Reaching the budget stops the run and preserves its incomplete denominator. A comparison model changes only
this explicit run, never production routing.

Each run records its fixture, decision, model, prompt version, duration, token
usage, and failure. Results save after each request so an interrupted run
retains its denominator. The report marks factual review pending. Inspect
every output, including successful machine checks, for wrong subjects, unit
swaps, unsupported certainty, and scientific claims. Failed requests can have
provider usage absent from the returned response; reconcile billing separately.

The release target is at least 95% intended-task success and no unresolved
critical factual errors. This runner executes no camera operations. Coordinator
and browser tests establish that unsupported or superseded operations never
execute. The machine grade checks requested subjects and plan size; it does
not replace a human judgment about whether an explanation answers the question.

## Live voice and transport audition

Use the application through `node scripts/drive.mjs`, following the `drive`
skill. Run the same Saturn overview, rings, Titan, and Enceladus material with
`marin`, `gleam`, `meridian`, and `vesper`, then a five-minute tour. Record the
browser, device, network, voice, prompt version, sample count, and the six
listening scores in the scorecard. Hide voice names during comparison where
practical. Do not infer a preferred voice from one greeting.

Verify the WebRTC offer exchange against the development Worker and an
authenticated staging Worker, the outbound sideband, and closure with final
cumulative seconds. Durable Object classes prevent automatic version preview
URLs for this Worker.
A sideband attaches to a running session without a second start command.
The browser's data channel cannot submit model commands. Verify this denial
with the selected project before admitting an alpha session.

Interrupt during an utterance, change Titan to Enceladus during a slow
response, mute the microphone separately from the guide, change audio devices,
hide the tab, and end during negotiation. Captions come from output transcript
fragments. Transcript silence and append acknowledgments do not finish a stop.
Live uses explicit Next; automatic tours use controlled clips and their
matching audio-ended event. Check that Stop silences immediately and an
obsolete completion never moves the camera.

[Live delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[Live session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations),
[Live sideband controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live),
and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) describe
the selected provider contracts. Account access and a passing fixture suite do
not establish listening quality or deployed transport behavior.

## Verbose message tracing

Set `TOUR_GUIDE_TRACE=true` in the root `.env.local` and restart `pnpm dev`
to print structured JSON events in the Worker terminal. Each event identifies
its session, sequence, event kind, and model. Traces include application
messages, director inputs and decisions, Live transcript fragments and control
messages, speech text, HTTP timing, token usage, reservations, and finalization.
Model IDs distinguish Astra reasoning, Live conversation, and mini-TTS clips.

Tracing is disabled in the committed deployment configuration. Enabling it in a
Worker environment deliberately logs conversation text. The trace sink redacts
credentials and cookies, omits SDP and binary audio, bounds each record, and
cannot interrupt a session when its writer fails. Ordinary operation keeps
conversation text out of Worker logs.

In the browser console, `ir.guideTrace(true)` enables application-message logs
with the `[tour browser]` prefix. `ir.guideTrace()` returns detached copies of
the latest 200 entries; `ir.guideTrace(false)` stops recording. It never records
the password form or authentication requests. Provider details remain in the
Worker trace, where the requests are actually sent.
