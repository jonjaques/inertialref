import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import {
  DIRECTOR_MODELS,
  synthesizeSpeech,
  GuideProviderError,
} from '../../apps/server/src/tour/openaiResponses.ts'
import { ASTRONOMY_NOTES } from '../../apps/server/src/tour/knowledge/astronomy.ts'
import {
  LIVE_VOICES,
  NARRATOR_PROMPT_VERSION,
} from '../../apps/server/src/tour/openaiLive.ts'

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'models' },
    'allow-spend': { type: 'boolean', default: false },
    out: { type: 'string', default: '.scratch/tour-probe' },
    'env-file': { type: 'string', default: '.env.local' },
    help: { type: 'boolean', default: false },
  },
})
if (values.help) {
  console.log(
    'node scripts/tour/probe.mjs --mode=models\nnode scripts/tour/probe.mjs --mode=speech --allow-spend --out=.scratch/tour-voice\nModel access probes use GET requests. Speech writes three bounded paid mini-TTS/marin clips for a listening baseline. Live voices require the application WebRTC audition described in scripts/tour/README.md.',
  )
  process.exit(0)
}
if (!['models', 'speech'].includes(values.mode))
  throw new Error('Probe mode must be models or speech.')
if (process.env.CI || (values.mode === 'speech' && !values['allow-spend']))
  throw new Error(
    'Speech probing requires --allow-spend outside CI; probes never run in CI.',
  )
try {
  process.loadEnvFile(values['env-file'])
} catch (error) {
  if (error?.code !== 'ENOENT')
    throw new Error('Could not load the evaluation environment file.')
}
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('OPENAI_API_KEY is required on this machine.')
const directory = resolve(values.out)
await mkdir(directory, { recursive: true })
if (values.mode === 'models') {
  const results = []
  for (const model of ['gpt-live-1', ...DIRECTOR_MODELS, 'gpt-4o-mini-tts']) {
    try {
      const response = await fetch(
        `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(12_000),
        },
      )
      results.push({ model, status: response.status, accessible: response.ok })
      await response.body?.cancel()
    } catch {
      results.push({ model, status: null, accessible: false })
    }
  }
  await writeFile(
    resolve(directory, 'access.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        results,
        qualification:
          'An accessible model listing does not verify session creation, voice quality, concurrency, WebRTC, or workerd sideband support.',
      },
      null,
      2,
    ),
  )
  console.log(
    `Wrote model access results to ${directory}. No conversation content is retained.`,
  )
} else {
  const samples = [
    { id: 'saturn', noteIds: ['saturn-rings', 'saturn-no-surface'] },
    { id: 'titan', noteIds: ['titan-weather', 'titan-huygens'] },
    { id: 'enceladus', noteIds: ['enceladus-ocean'] },
  ]
  const results = []
  for (const sample of samples) {
    const notes = sample.noteIds.map((id) =>
      ASTRONOMY_NOTES.find((note) => note.id === id),
    )
    const text = notes.map((note) => note.speech).join(' ')
    const started = process.hrtime.bigint()
    try {
      const audio = await synthesizeSpeech({ apiKey, text })
      await writeFile(resolve(directory, `${sample.id}.mp3`), audio)
      results.push({
        id: sample.id,
        text,
        sources: notes.map((note) => note.url),
        bytes: audio.byteLength,
        generationMs: Number(process.hrtime.bigint() - started) / 1e6,
        error: null,
      })
    } catch (error) {
      results.push({
        id: sample.id,
        error:
          error instanceof GuideProviderError ? error.code : 'probe-failed',
      })
    }
  }
  await writeFile(
    resolve(directory, 'voice-scorecard.json'),
    JSON.stringify(
      {
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        promptVersion: NARRATOR_PROMPT_VERSION,
        liveVoicesToAudition: LIVE_VOICES,
        samples: results,
        listener: {
          browser: '',
          device: '',
          headphones: '',
          network: '',
          sampleCount: 0,
          clarity: null,
          interest: null,
          pronunciation: null,
          pacing: null,
          fatigue: null,
          interruptionRecovery: null,
          notes: '',
        },
        qualification:
          'This is controlled narration. Its audio and completion behavior do not evaluate GPT Live.',
      },
      null,
      2,
    ),
  )
  console.log(
    `Wrote controlled-narration samples and a blank listening scorecard to ${directory}.`,
  )
}
