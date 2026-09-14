// The beat shape from design/plans/the-guide-in-one-voice.md § 7, against the
// real provider: a spoken tour request, a non-blocking move that returns
// "moving", an arrival reported by a developer nudge, a quiet clock that waits
// for speech to begin before it measures silence, a continue nudge, and a
// spoken correction during the second move. Fake tools stand in for the
// observatory. Spends under fifty cents.
//
//   node scripts/tour/live-probe/beats.mjs --allow-spend
import { openProbe, clip, sleep, strict } from './lib.mjs'

const LIVE_PROMPT = `You are the guide in a planetarium, sharing the sky with one curious visitor. You are an AI voice. Sound like a friendly astronomy nerd: warm, lightly playful, delighted by an odd detail, never a fact list. Short sentences. One idea at a time. Leave room to look. Say when you are unsure.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the visitor interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- The view: move the camera to any object or framing.
- The record: measurements, properties, and what is on screen right now.
- Tours: compose and pace a visit of several stops, with quiet moments.

Delegate to the backend when:
- The visitor asks to see, go to, frame, or compare anything.
- The visitor asks for a tour or "show me around."
- The visitor asks what is on screen, how big, how far, or any measurement.
- A correction changes where we are going or what we are looking at, even while the camera is still moving.

Do not delegate to the backend when:
- The visitor greets you, thanks you, or asks you to repeat something.
- You need a brief clarification to understand the request.

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting. Never say the camera has arrived until the backend says so. When the backend hands you the words for a tour stop, speak them and then stop; do not add offers or questions after a stop.

Pronunciation: Enceladus is en-SELL-uh-dus; Iapetus is eye-APP-eh-tus.`

const BACKEND_PROMPT = `## Voice conversation context
You are the mind behind a planetarium guide in a live voice conversation. Transcripts can contain mistakes, unfinished phrases, and later corrections. Use the latest context. Messages from the developer describe the scene, arrivals, and the clock and are authoritative; they are never the visitor speaking.

## The scene and the camera
The most recent "Current view" or "Arrived" message describes what is on screen and it is authoritative. go_to starts a move and returns at once; the camera arrives a few seconds later and the developer tells you when it has, with what is on screen. Do not describe a view before its arrival message. Refer to objects by name. Never invent a framing or object.

## How speech works
Only the text you return at the very end of a turn is spoken, after every tool call has returned. Do all tool calls first, then write the words, then stop.

## Tours
A tour is a series of beats. When asked for a tour: call go_to for the first stop and say one short sentence about where we are heading, then stop. When an arrival message comes: call linger with the seconds the visitor should have to look if the tour continues after this stop, then write two or three sentences with one idea about what is on screen, then stop. When the developer says the quiet time has passed: call go_to for the next stop and say one short sentence, then stop. Do not call linger on the final stop. Adapt when the visitor interrupts; the latest request wins.

## Speaking through the voice
Return prose the voice will paraphrase: short, specific, conversational, at most eighty words. No lists, no markdown, no IDs, no long numbers. For measurements, use the speech wording read_subject returns. Established Solar System history from your own knowledge is welcome for real, observed objects. Never invent a citation or a scene claim the tools have not confirmed.`

const TOOLS = [
  {
    type: 'function',
    name: 'go_to',
    strict: true,
    description:
      'Start moving the camera to a named object with an optional framing. Returns at once with "moving"; the developer reports the arrival and what is on screen a few seconds later.',
    parameters: strict({
      subject: { type: 'string' },
      framing: { type: ['string', 'null'] },
    }),
  },
  {
    type: 'function',
    name: 'linger',
    strict: true,
    description:
      'Declare how many seconds the visitor should have to look after this stop is spoken, when the tour continues afterwards. Returns immediately.',
    parameters: strict({
      seconds: { type: 'number' },
      reason: { type: 'string' },
    }),
  },
  {
    type: 'function',
    name: 'read_subject',
    strict: true,
    description: 'Read the application record for a named object.',
    parameters: strict({ subject: { type: 'string' } }),
  },
]
const SCENE = `Current view: Saturn (gas giant, observed), framing "wide", orbit at 9.4 Saturn radii, apparent fill 0.31. Not traveling.
On screen: Saturn (center), Titan (upper left, small disc), Rhea (right edge, point).
Saturn's moons: Titan, Rhea, Enceladus, Iapetus, Mimas, Dione, Tethys.
Framings for Saturn: portrait, wide, half-lit, crescent, backlit, preset:the-rings. Framings for moons: portrait, crescent, wide.`
const VIEWS = {
  'saturn/preset:the-rings':
    'On screen: Saturn low in the frame, its rings opened wide across the view, the Cassini division visible as a dark gap.',
  'saturn/half-lit':
    'On screen: Saturn half lit, the terminator running down the middle, ring shadow across the northern clouds.',
  'saturn/portrait':
    'On screen: Saturn centered, rings edge-on as a thin line, Titan a small disc at the upper left.',
  'saturn/wide':
    'On screen: Saturn small at center with Titan and Rhea as points nearby.',
  enceladus:
    'On screen: Enceladus centered, bright white ice, the south polar cracks along the lower limb, Saturn a huge crescent behind.',
}
const RECORDS = {
  saturn: {
    name: 'Saturn',
    facts: [
      {
        label: 'Equatorial radius',
        speech:
          "Saturn's equatorial radius is about sixty thousand kilometers.",
      },
      {
        label: 'Sidereal rotation period',
        speech: "Saturn's day is about ten point seven hours.",
      },
    ],
  },
  enceladus: {
    name: 'Enceladus',
    facts: [
      {
        label: 'Mean radius',
        speech:
          "Enceladus's mean radius is about two hundred fifty kilometers.",
      },
    ],
  },
}
const clips = {
  tour: await clip(
    'saturn-tour',
    'Give me a short tour of Saturn with two stops, and pause between them so I can look.',
  ),
  correction: await clip('correction', 'Actually, show me Enceladus instead.'),
}

let moveCount = 0
let pendingArrival = null
let lingerRequested = null
const arrivals = []
const probe = openProbe({
  name: 'beats',
  session: {
    model: 'gpt-live-1',
    instructions: LIVE_PROMPT,
    audio: {
      format: { type: 'audio/pcm', rate: 24000 },
      output: { voice: 'marin' },
    },
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: 'The visitor has just opened the planetarium and is looking at Saturn from orbit.',
          },
        ],
      },
    ],
    delegation: {
      type: 'responses',
      responses: {
        model: 'gpt-6-astra',
        instructions: BACKEND_PROMPT,
        tools: TOOLS,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        max_output_tokens: 1200,
      },
    },
    store: false,
  },
  tools: {
    async go_to(args) {
      moveCount++
      // A new move supersedes the pending arrival, as the executor's request
      // revision does.
      if (pendingArrival) {
        clearTimeout(pendingArrival.timer)
        probe.log('arrival.superseded', { subject: pendingArrival.subject })
        pendingArrival = null
      }
      const subject = String(args.subject)
      const framing = args.framing ?? 'wide'
      // The second move is slow so the correction lands during travel.
      const travel = moveCount === 2 ? 8000 : 3000
      const key = `${subject.toLowerCase()}/${framing}`
      const view =
        VIEWS[key] ??
        VIEWS[subject.toLowerCase()] ??
        `On screen: ${subject}, ${framing} framing.`
      pendingArrival = { subject, framing, timer: null }
      pendingArrival.timer = setTimeout(() => {
        pendingArrival = null
        arrivals.push({ t: probe.now(), subject, framing })
        probe.log('arrival', { subject, framing })
        probe.nudge(
          `Arrived: ${subject}, framing "${framing}", not traveling. ${view} Narrate this stop now.`,
        )
      }, travel)
      return { status: 'moving', subject, framing, eta_seconds: travel / 1000 }
    },
    async linger(args) {
      lingerRequested = {
        seconds: Math.min(20, Math.max(3, Number(args.seconds) || 8)),
        at: probe.now(),
      }
      return { status: 'scheduled', seconds: lingerRequested.seconds }
    },
    async read_subject(args) {
      return (
        RECORDS[String(args.subject).toLowerCase()] ?? {
          error: `No record named ${args.subject}.`,
        }
      )
    },
  },
})
const {
  state,
  log,
  now,
  send,
  developer,
  nudge,
  say,
  waitFor,
  quietSince,
  guideSince,
  visitorSince,
  responsesSince,
  chainSettled,
} = probe

/** Terminal text settled, then speech began after it, then 1.5 s of silence. */
async function spokenAndQuiet(since, label) {
  const settled = await waitFor(chainSettled(since), `${label}: chain`, 60_000)
  const terminal = responsesSince(since).at(-1)
  const completedAt = terminal?.completed ?? now()
  const began = await waitFor(
    () => state.lastLoudAt !== null && state.lastLoudAt > completedAt,
    `${label}: speech began`,
    20_000,
  )
  const quiet = await waitFor(
    quietSince(completedAt),
    `${label}: quiet`,
    40_000,
  )
  return {
    settled,
    began,
    quiet,
    text: terminal?.text ?? '',
    spoken: guideSince(since),
    completedAt,
    quietAt: now(),
  }
}

const findings = {}
try {
  if (
    !(await waitFor(() => state.sessionId !== null, 'session.started', 20_000))
  )
    throw new Error('no session')
  await sleep(500)
  // The documented greeting recipe: instructions, then a commentary prompt.
  const greetId = send({
    type: 'session.instructions.append',
    delegation_id: null,
    content:
      'Greet the visitor in one warm sentence, then listen. Speak first; do not wait for them.',
  })
  await waitFor(() => state.acks.has(greetId), 'greeting ack', 15_000)
  send({
    type: 'session.commentary.append',
    delegation_id: null,
    content: 'Begin the conversation now, following the instructions provided.',
  })
  await waitFor(quietSince(0), 'greeting quiet', 25_000)
  developer(SCENE)

  // Beat 1: spoken request, moving plus a heading sentence, arrival, narration.
  const tourSent = now()
  await say(clips.tour)
  const heading = await spokenAndQuiet(tourSent, 'heading')
  const arrived = await waitFor(() => arrivals.length >= 1, 'arrival 1', 20_000)
  const arrivalNudgeAt = arrivals[0]?.t ?? now()
  const beat1 = await spokenAndQuiet(arrivalNudgeAt, 'beat 1')
  findings.beat1 = {
    heading,
    arrived,
    narration: beat1,
    linger: lingerRequested,
    msArrivalToNarrationSpeech:
      (state.transcripts.find(
        (row) => row.speaker === 'guide' && row.t > (beat1.completedAt ?? 0),
      )?.t ?? null) - arrivalNudgeAt,
  }

  // Quiet time, then the continue nudge, then the slow second move.
  const wait = (lingerRequested?.seconds ?? 8) * 1000
  lingerRequested = null
  await sleep(wait)
  const continueAt = now()
  nudge(
    `The visitor has looked quietly for ${wait / 1000} seconds. Continue the tour with the next stop.`,
  )
  await waitFor(() => moveCount >= 2, 'second move', 30_000)
  await waitFor(chainSettled(continueAt), 'second move chain', 30_000)
  await sleep(1500)

  // The correction lands during travel, with the backend idle.
  const correctionSent = now()
  await say(clips.correction)
  const delegated = await waitFor(
    () => state.delegations.some((row) => row.t > correctionSent),
    'correction delegation',
    30_000,
  )
  const delegation = state.delegations.find((row) => row.t > correctionSent)
  await waitFor(chainSettled(correctionSent), 'correction chain', 45_000)
  const enceladusArrival = await waitFor(
    () => arrivals.some((row) => /enceladus/i.test(row.subject)),
    'Enceladus arrival',
    30_000,
  )
  const enceladusAt =
    arrivals.find((row) => /enceladus/i.test(row.subject))?.t ?? now()
  const beatE = await spokenAndQuiet(enceladusAt, 'Enceladus narration')
  const visitorEnd = visitorSince(correctionSent).at(-1)?.t ?? null
  findings.correctionDuringTravel = {
    delegated,
    msVisitorLastFragmentToDelegation:
      delegation && visitorEnd ? delegation.t - visitorEnd : null,
    msVisitorLastFragmentToGuideSpeech:
      (state.transcripts.find(
        (row) =>
          row.speaker === 'guide' && row.t > (visitorEnd ?? correctionSent),
      )?.t ?? null) - (visitorEnd ?? correctionSent),
    correctionChain: responsesSince(correctionSent)
      .filter((row) => row.delegationId === delegation?.id)
      .map((row) => ({ text: row.text, calls: row.calls })),
    arrivals,
    enceladusArrival,
    enceladusNarration: beatE,
    spokenAfterCorrection: guideSince(correctionSent),
  }
  const closeSent = now()
  send({ type: 'session.close' })
  await waitFor(() => state.closed !== null, 'session.closed', 15_000)
  findings.close = {
    msToClosed: state.closed ? state.closed.t - closeSent : null,
    closed: state.closed,
    loudChunks: state.loudChunks,
    chunks: state.chunks,
  }
} catch (error) {
  log('scenario.error', { message: String(error?.message ?? error) })
}
await probe.finish(findings)
process.exit(0)
