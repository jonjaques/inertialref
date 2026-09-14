// Shared machinery for the primary-WebSocket GPT Live probes: session startup,
// paced synthetic input, energy-based speech detection, the Responses
// delegation tool loop, waiters, and the trace. A scenario imports this and
// supplies its prompts, tools, and steps. Every run spends money; the
// scenarios refuse to start without --allow-spend.
//
// Output audio arrives as a continuous stream of PCM frames whether or not the
// guide is talking, so "speaking" is an RMS level over a frame, not the
// presence of a frame. The threshold is 200 of 32767; measured silence frames
// sit near zero and speech frames near 1,000 to 3,000.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
export const root = resolve(here, '../../..')
export const scratch = resolve(root, '.scratch/live-probe')

const { values } = parseArgs({
  options: {
    'allow-spend': { type: 'boolean', default: false },
    'env-file': { type: 'string', default: '.env.local' },
  },
})
if (process.env.CI || !values['allow-spend'])
  throw new Error('Live probes spend money: pass --allow-spend outside CI.')
process.loadEnvFile(resolve(root, values['env-file']))
export const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('OPENAI_API_KEY is required.')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const strict = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

/** PCM16 mono 24 kHz for a visitor line, cached so a rerun pays for Live only. */
export async function clip(slug, text) {
  const path = resolve(scratch, 'clips', `${slug}.pcm`)
  if (existsSync(path)) return readFile(path)
  await mkdir(resolve(scratch, 'clips'), { recursive: true })
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: text,
      response_format: 'pcm',
    }),
  })
  if (!response.ok) throw new Error(`TTS failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(path, bytes)
  return bytes
}

function rms(base64) {
  const bytes = Buffer.from(base64, 'base64')
  const samples = bytes.length >> 1
  let sum = 0
  for (let index = 0; index < samples; index++) {
    const value = bytes.readInt16LE(index * 2)
    sum += value * value
  }
  return samples === 0 ? 0 : Math.sqrt(sum / samples)
}

/**
 * Open a session. `tools` maps a tool name to `async (args, call) => output`;
 * a handler may set `call.cancel(reason)` to be released early. `onVisitor`
 * runs on every visitor transcript fragment with the pending calls, and
 * `beforeContinue` may return developer messages to queue before the
 * continuation that follows a tool output.
 */
export function openProbe({
  name,
  session,
  tools,
  onVisitor = () => {},
  beforeContinue = () => [],
}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = resolve(scratch, `${name}-${stamp}`)
  const t0 = Date.now()
  const now = () => Date.now() - t0
  const trace = []
  function log(kind, data = {}) {
    const entry = { t: now(), kind, ...data }
    trace.push(entry)
    const line = JSON.stringify(entry)
    console.log(line.length > 300 ? `${line.slice(0, 300)}…` : line)
  }
  const state = {
    sessionId: null,
    expiresAt: null,
    lastLoudAt: null,
    loudChunks: 0,
    chunks: 0,
    transcripts: [],
    delegations: [],
    responses: new Map(),
    pending: new Map(),
    acks: new Map(),
    usage: [],
    errors: [],
    closed: null,
  }
  const waiters = []
  function waitFor(predicate, label, timeoutMs) {
    return new Promise((resolve) => {
      const entry = { done: false }
      const timer = setTimeout(() => {
        if (entry.done) return
        entry.done = true
        log('wait.timeout', { label, timeoutMs })
        resolve(false)
      }, timeoutMs)
      entry.check = () => {
        if (!entry.done && predicate()) {
          entry.done = true
          clearTimeout(timer)
          resolve(true)
        }
      }
      waiters.push(entry)
      entry.check()
    })
  }
  const ticker = setInterval(() => {
    for (const entry of waiters) entry.check()
  }, 100)
  ticker.unref()
  const speaking = () =>
    state.lastLoudAt !== null && now() - state.lastLoudAt < 1500
  const quietSince =
    (since, gapMs = 1500) =>
    () =>
      state.lastLoudAt !== null &&
      state.lastLoudAt > since &&
      now() - state.lastLoudAt >= gapMs
  const guideSince = (since) =>
    state.transcripts
      .filter((row) => row.speaker === 'guide' && row.t > since)
      .map((row) => row.delta)
      .join('')
  const visitorSince = (since) =>
    state.transcripts.filter(
      (row) => row.speaker === 'visitor' && row.t > since,
    )
  const responsesSince = (since) =>
    [...state.responses.values()].filter((row) => row.created > since)
  // A chain is settled when its last response ended without a tool call.
  const chainSettled = (since) => () =>
    responsesSince(since).length >= 1 &&
    responsesSince(since).every((row) => row.completed !== null) &&
    state.pending.size === 0 &&
    responsesSince(since).at(-1).calls.length === 0

  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  let sequence = 0
  function send(event) {
    const message = {
      ...event,
      event_id: event.event_id ?? `probe-${++sequence}`,
    }
    ws.send(JSON.stringify(message))
    if (message.type !== 'session.input_audio.append') log('send', { message })
    return message.event_id
  }
  const developer = (text) =>
    send({
      type: 'response.item.create',
      item: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text }],
      },
    })
  const nudge = (text) => {
    developer(text)
    send({ type: 'response.create' })
  }

  // 100 ms of PCM16 mono at 24 kHz every 100 ms; silence when no clip is
  // queued, because the provider's clock stalls without input audio.
  const FRAME = 4800
  const queue = []
  const say = (pcm) =>
    new Promise((resolve) => queue.push({ pcm, offset: 0, resolve }))
  const silence = Buffer.alloc(FRAME)
  const pacer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || state.sessionId === null) return
    let frame = silence
    const head = queue[0]
    if (head) {
      const end = Math.min(head.offset + FRAME, head.pcm.length)
      frame = head.pcm.subarray(head.offset, end)
      head.offset = end
      if (head.offset >= head.pcm.length) {
        queue.shift()
        head.resolve()
      }
      if (frame.length < FRAME)
        frame = Buffer.concat([frame, Buffer.alloc(FRAME - frame.length)])
    }
    ws.send(
      JSON.stringify({
        type: 'session.input_audio.append',
        audio: frame.toString('base64'),
      }),
    )
  }, 100)

  async function runTool(call) {
    let args = {}
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      /* The output below reports the unusable arguments. */
    }
    call.args = args
    const started = now()
    log('tool.start', {
      name: call.name,
      call_id: call.call_id,
      args,
      response_id: call.responseId,
    })
    let output
    try {
      output = tools[call.name]
        ? await tools[call.name](args, call)
        : { error: `Unknown tool ${call.name}` }
    } catch (error) {
      output = { error: String(error?.message ?? error) }
    }
    log('tool.done', {
      name: call.name,
      call_id: call.call_id,
      ms: now() - started,
      output,
    })
    state.pending.delete(call.call_id)
    send({
      type: 'response.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(output),
      },
    })
    for (const text of beforeContinue(call)) developer(text)
    send({ type: 'response.create' })
  }

  ws.on('open', () => {
    log('ws.open')
    send({ type: 'session.start', session })
  })
  ws.on('error', (error) =>
    log('ws.error', { message: String(error?.message ?? error) }),
  )
  ws.on('close', (code, reason) =>
    log('ws.close', { code, reason: String(reason) }),
  )
  ws.on('message', (data) => {
    let event
    try {
      event = JSON.parse(String(data))
    } catch {
      return
    }
    const type = event.type
    if (type === 'session.output_audio.delta') {
      state.chunks++
      const level = rms(event.delta ?? '')
      if (level > 200) {
        if (!speaking()) log('speech.start', { level: Math.round(level) })
        state.lastLoudAt = now()
        state.loudChunks++
      }
      return
    }
    if (type === 'session.started') {
      state.sessionId = event.session?.id ?? null
      state.expiresAt = event.session?.expires_at ?? null
      log('session.started', {
        id: state.sessionId,
        expires_at: state.expiresAt,
      })
      return
    }
    if (
      type === 'session.input_transcript.delta' ||
      type === 'session.output_transcript.delta'
    ) {
      const speaker =
        type === 'session.input_transcript.delta' ? 'visitor' : 'guide'
      state.transcripts.push({
        t: now(),
        speaker,
        delta: event.delta,
        start_ms: event.start_ms,
        end_ms: event.end_ms,
      })
      log('transcript', {
        speaker,
        delta: event.delta,
        start_ms: event.start_ms,
      })
      if (speaker === 'visitor') onVisitor(event, [...state.pending.values()])
      return
    }
    if (type === 'session.delegation.created') {
      state.delegations.push({
        t: now(),
        ...event.delegation,
        offset_ms: event.offset_ms,
      })
      log('delegation', {
        delegation: event.delegation,
        offset_ms: event.offset_ms,
      })
      return
    }
    if (type === 'response.event') {
      const nested = event.event ?? {}
      const nestedType = nested.type
      const delegationId = event.delegation_id ?? null
      if (nestedType === 'response.created') {
        const id = nested.response?.id
        state.responses.set(id, {
          id,
          delegationId,
          created: now(),
          text: '',
          completed: null,
          usage: null,
          status: null,
          calls: [],
        })
        log('response.created', {
          response_id: id,
          delegation_id: delegationId,
        })
      } else if (nestedType === 'response.output_item.done') {
        const item = nested.item ?? {}
        const response =
          [...state.responses.values()].find(
            (row) =>
              row.completed === null && row.delegationId === delegationId,
          ) ?? [...state.responses.values()].at(-1)
        if (item.type === 'function_call') {
          const call = {
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            responseId: response?.id ?? null,
            delegationId,
          }
          response?.calls.push(`${item.name}(${item.arguments})`)
          state.pending.set(item.call_id, call)
          log('function_call', {
            name: item.name,
            call_id: item.call_id,
            arguments: item.arguments,
            response_id: call.responseId,
          })
          void runTool(call)
        } else if (item.type === 'message') {
          const text = (item.content ?? [])
            .filter((part) => part.type === 'output_text')
            .map((part) => part.text)
            .join('')
          if (response) response.text += text
          log('message.done', { response_id: response?.id, text })
        }
      } else if (
        nestedType === 'response.completed' ||
        nestedType === 'response.failed' ||
        nestedType === 'response.incomplete'
      ) {
        const id = nested.response?.id
        const response = state.responses.get(id)
        if (response) {
          response.completed = now()
          response.usage = nested.response?.usage ?? null
          response.status = nestedType
        }
        log(nestedType, {
          response_id: id,
          usage: nested.response?.usage ?? null,
          error: nested.response?.error ?? null,
        })
      } else if (
        !/\.delta$|\.added$|\.in_progress$|\.done$/.test(nestedType ?? '')
      ) {
        log('response.event.other', { nested_type: nestedType })
      }
      return
    }
    if (type === 'session.usage.updated') {
      state.usage.push({ t: now(), ...event.usage })
      return
    }
    if (/\.appended$|\.muted$|\.unmuted$/.test(type ?? '')) {
      state.acks.set(event.client_event_id, {
        t: now(),
        type,
        start_ms: event.start_ms,
        end_ms: event.end_ms,
      })
      log('ack', { type, client_event_id: event.client_event_id })
      return
    }
    if (type === 'session.closed') {
      state.closed = { t: now(), reason: event.reason, usage: event.usage }
      log('session.closed', { reason: event.reason, usage: event.usage })
      return
    }
    if (type === 'error') {
      state.errors.push({ t: now(), error: event.error })
      log('error', { error: event.error })
      return
    }
    log('event', { type })
  })

  async function finish(findings) {
    clearInterval(pacer)
    clearInterval(ticker)
    try {
      if (ws.readyState === WebSocket.OPEN) {
        if (state.closed === null) {
          send({ type: 'session.close' })
          await waitFor(() => state.closed !== null, 'session.closed', 10_000)
        }
        ws.close()
      }
    } catch {
      /* The trace below records whatever the socket did. */
    }
    await mkdir(out, { recursive: true })
    await writeFile(
      resolve(out, 'trace.jsonl'),
      trace.map((row) => JSON.stringify(row)).join('\n'),
    )
    await writeFile(
      resolve(out, 'summary.json'),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          sessionId: state.sessionId,
          findings,
          responses: [...state.responses.values()],
          delegations: state.delegations,
          transcripts: state.transcripts,
          usage: state.usage,
          errors: state.errors,
          closed: state.closed,
          loudChunks: state.loudChunks,
          chunks: state.chunks,
        },
        null,
        2,
      ),
    )
    console.log(`\nWrote ${out}`)
    console.log(JSON.stringify(findings, null, 2))
  }

  return {
    ws,
    state,
    trace,
    log,
    now,
    send,
    developer,
    nudge,
    say,
    waitFor,
    speaking,
    quietSince,
    guideSince,
    visitorSince,
    responsesSince,
    chainSettled,
    finish,
    out,
  }
}
