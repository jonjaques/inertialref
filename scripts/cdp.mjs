/*
 * The wire under `scripts/drive.mjs`: one DevTools Protocol socket, a
 * command channel over it, and the recordings that listen to its events.
 *
 * Nothing here touches the file system or launches anything. A `WebSocket` —
 * the real one, or the fake `cdp.test.mjs` scripts — goes in; `send`, the
 * buffered events and `subscribe` come out, and every recording returns what it
 * collected for the caller to write.
 */
import { wrap } from './driveScript.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A command channel over an open socket. Each reply is matched to the id its
 * command was sent with; an event goes to the subscribers first and is
 * buffered in `events` unless one of them consumed it.
 */
export function connect(ws) {
  let next = 1
  const pending = new Map()
  const events = []
  /*
   * Synchronous listeners, and they may swallow the message.
   *
   * Screencast is the reason. Chrome sends the next frame only once the
   * previous one is acknowledged, so an acknowledgement that waits on a poll
   * loop throttles the stream to whatever the poll interval is — a 16 ms poll
   * measured 18 fps on a page running at 60, which subsamples the capture and
   * drops exactly the one-frame artifact a cast is taken to find. Acking from
   * inside the message handler is what keeps the stream at the page's own rate.
   */
  const listeners = new Set()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === undefined) {
      let consumed = false
      for (const listener of listeners)
        if (listener(msg) === true) consumed = true
      if (!consumed) events.push(msg)
      return
    }
    const entry = pending.get(msg.id)
    if (entry === undefined) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
    else entry.resolve(msg.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++
      // Cleared on the reply, and `unref`d besides. A two-minute timer left
      // armed on every command holds the event loop open, so an invocation
      // that finished its work in one second still took two minutes to exit —
      // which reads as a hung driver and is a forgotten timer.
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 120_000)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  // A socket that goes away takes every command in flight with it, and those
  // timers are `unref`d — so without this the process drains its event loop
  // and exits 0 having answered nothing, which reads as a passing run against
  // a Chrome that crashed. `pending` is empty by the time `main` closes the
  // socket itself, so the ordinary shutdown lands here as a no-op.
  const abandon = (why) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error(why))
    }
  }
  ws.addEventListener('close', () => abandon('the CDP socket closed'))
  ws.addEventListener('error', () => abandon('the CDP socket errored'))
  /** Returns its own removal, so a step cannot leak a listener into the next. */
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return { send, events, subscribe }
}

/** `expression` in the page, by value, with an exception as a rejection
 *  carrying the page's own description of it. */
export async function evaluate(send, expression, userGesture = false) {
  const result = await send('Runtime.evaluate', {
    expression: wrap(expression),
    awaitPromise: true,
    returnByValue: true,
    ...(userGesture ? { userGesture: true } : {}),
  })
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        JSON.stringify(result.exceptionDetails),
    )
  }
  return result.result.value
}

/** Console output and page exceptions buffered since the last drain, as lines. */
export function drainLogs(events) {
  const lines = []
  for (const event of events.splice(0)) {
    if (event.method === 'Runtime.consoleAPICalled') {
      const text = event.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
      lines.push(`${event.params.type}: ${text}`)
    } else if (event.method === 'Runtime.exceptionThrown') {
      lines.push(
        `exception: ${
          event.params.exceptionDetails.exception?.description ??
          event.params.exceptionDetails.text
        }`,
      )
    }
  }
  return lines
}

/**
 * A burst of frames as the compositor actually presented them, oldest first.
 *
 * `--shot` cannot see a strobe. `Page.captureScreenshot` draws a frame of its
 * own on demand, so a one-frame artifact that recurs on a fixed period is
 * precisely what it never lands on — eight consecutive shots of a strobing
 * scene came back identical to six pixels while the page was visibly jumping
 * twice a second. A screencast is the compositor's own output, at the rate the
 * page is running, which is the only place the bad frame exists.
 *
 * Frames are acknowledged as they arrive because Chrome stops sending until
 * the previous one is, so a collector that batches its acks measures its own
 * back-pressure instead of the page.
 */
export async function castFrames(
  { send, subscribe },
  count,
  { maxPx, wait = sleep, now = Date.now },
) {
  const frames = []
  const unsubscribe = subscribe((msg) => {
    if (msg.method !== 'Page.screencastFrame') return false
    // Acknowledge first. The frame is already in hand and the next one does
    // not start until this returns; anything done before it is latency the
    // capture rate pays for.
    void send('Page.screencastFrameAck', { sessionId: msg.params.sessionId })
    if (frames.length < count)
      frames.push({ data: msg.params.data, at: msg.params.metadata.timestamp })
    // Consumed, so `drainLogs` still sees only console output and exceptions.
    return true
  })
  /*
   * JPEG, and capped well under the drawing buffer.
   *
   * The capture rate is bounded by how fast Chrome can encode a frame, not by
   * how fast the page draws one: PNG at a 3840x2400 retina buffer measured
   * 17 fps on a page running at 60, which subsamples the stream and drops the
   * one-frame artifact this exists to catch. At 1280 px and JPEG it keeps up.
   * Nothing is lost — the difference runs at 480 px, because that is what
   * averages away compression ringing and single-pixel star twinkle.
   */
  await send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: maxPx,
    maxHeight: maxPx,
    everyNthFrame: 1,
  })
  const deadline = now() + Math.max(10_000, count * 200)
  while (frames.length < count && now() < deadline) await wait(16)
  await send('Page.stopScreencast')
  unsubscribe()
  return frames.sort((a, b) => a.at - b.at)
}

/**
 * A Chrome trace over a window, as the event list `scripts/timing.mjs` reads.
 *
 * The categories are the narrow set that carries what this project emits.
 * `blink.user_timing` is where `performance.measure` lands and
 * `disabled-by-default-devtools.timeline` is where the extended
 * `console.timeStamp` does; `devtools.timeline` brings the frame and raster
 * events that put them in context. The V8 CPU profiler is deliberately absent —
 * it multiplies the file size and answers a different question, and a trace
 * nobody can open is a trace nobody reads.
 *
 * `Tracing.dataCollected` arrives in chunks and `Tracing.tracingComplete` is the
 * end. Collecting into an array and writing once is fine at these sizes; a
 * stream would be the right shape only for a recording long enough that the
 * frames in it are no longer the question.
 */
export async function traceFor(
  { send, subscribe },
  ms,
  { wait = sleep, now = Date.now } = {},
) {
  const events = []
  let complete = false
  const unsubscribe = subscribe((msg) => {
    if (msg.method === 'Tracing.dataCollected') {
      // A loop rather than `push(...chunk)`. Chrome chooses the chunk size and
      // a spread is an argument list, so a large one throws `RangeError` from
      // inside the socket's message handler — where the step's own `await`
      // cannot catch it, so `--down` never runs and the browser is orphaned.
      for (const event of msg.params.value) events.push(event)
      return true
    }
    if (msg.method === 'Tracing.tracingComplete') {
      complete = true
      return true
    }
    return false
  })

  // In a `finally`, because a throw from `Tracing.start` — an unknown category,
  // a target that went away — would otherwise leave this listener attached for
  // the rest of the session, still appending to an array nothing will write.
  try {
    await send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        includedCategories: [
          'blink.user_timing',
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'disabled-by-default-devtools.timeline.frame',
          'v8.execute',
        ],
      },
    })
    await wait(ms)
    await send('Tracing.end')
    // Chrome flushes after `end`, so the events are still arriving here.
    const deadline = now() + 30_000
    while (!complete && now() < deadline) await wait(50)
  } finally {
    unsubscribe()
  }
  return events
}
