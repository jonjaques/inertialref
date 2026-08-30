import { type MediaObject, type StorageRange, resolveRange } from './media.ts'

/*
 * One media object, from the bundle if it is there and from R2 if it is not.
 *
 * Separated from `index.ts` for the reason `routes.ts` is: this is the half
 * with decisions in it. Routing decides *which* object; this decides which
 * store answers, which of four status codes says so, and what the headers
 * claim — and every bug this path has shipped was in one of those three, never
 * in `resolveRange`, the one piece that already had an interface to be tested
 * through.
 *
 * The seam is `MediaStores`. It sits one level above `resolveRange`, between
 * the Worker's bindings and the response arithmetic, and it is a structural
 * type rather than `Env` so that the arithmetic is reachable from plain Node.
 * Two adapters make it real: `index.ts` passes workerd's, `serveMedia.test.ts`
 * passes an in-memory one.
 */

/* ------------------------------------------------------------------------- */
/* The seam                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * An object in the bucket, restated as the little of it this module reads.
 *
 * Restated rather than imported from the generated workerd types for the same
 * reason `media.ts` restates `R2Range`: naming what we depend on is what lets
 * a test satisfy it. The alternative is a fake that has to implement
 * `arrayBuffer`, `checksums`, `storageClass` and eight other members nothing
 * here touches, which is how a seam ends up existing only on paper.
 */
export interface StoredObject {
  readonly size: number
  readonly httpEtag: string
  /**
   * Populated with or without a `Range` header — an unranged get reports the
   * whole object as its range. Never key a status off it; see below.
   */
  readonly range?: StorageRange
  writeHttpMetadata(headers: Headers): void
}

/**
 * The same object, carrying bytes.
 *
 * The two are separate types because a conditional `get` whose precondition
 * fails returns the metadata *without* a body, and `'body' in stored` is what
 * tells the two apart. That branch is the whole reason the 304 path works.
 */
export interface StoredObjectBody extends StoredObject {
  readonly body: ReadableStream | null
}

/**
 * The get options, mirroring the two R2 actually receives.
 *
 * Both are required, and not for tidiness: R2's `get` is overloaded, and only
 * the overload with `onlyIf` present returns the body-less `R2Object` that the
 * 304 branch exists for. Making them optional here would quietly select the
 * other overload in the adapter and delete that branch's reason to exist.
 *
 * They are handed the request's own headers because R2 parses `Range`,
 * `If-None-Match` and the rest itself, which is the only way to get this right
 * without reimplementing RFC 9110 in a Worker.
 */
export interface MediaGetOptions {
  readonly range: Headers
  readonly onlyIf: Headers
}

/** The two stores a media request can be answered from. */
export interface MediaStores {
  /** The asset binding: may answer, may fall through, may ignore `Range`. */
  asset(request: Request): Promise<Response>
  /** R2 by key. Throws on a `Range` it cannot satisfy — that is the 416. */
  get(
    key: string,
    options: MediaGetOptions,
  ): Promise<StoredObjectBody | StoredObject | null>
  head(key: string): Promise<StoredObject | null>
}

/* ------------------------------------------------------------------------- */
/* The response                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Answer a `/media/` request.
 *
 * The order is not a preference, it is a cost: an asset request is free, never
 * leaves the asset store, and gets `Range` right without any of the code below.
 * R2 is the guarantee behind it — a build that ran without credentials produces
 * a bundle with no audio, and this is what makes that a slower first byte
 * rather than a missing feature. `media.ts` has the whole arrangement.
 *
 * **The miss is detected by content type, and that is not a heuristic.**
 * A path the asset store does not have comes back as HTML — the 404
 * document, or an SPA document wearing that URL. Nothing under `/media/`
 * is ever HTML, so an HTML answer to a request for an `.mp3` is
 * unambiguous — and the alternative, trusting the status, hands an
 * `<audio>` element a page of markup.
 *
 * **The asset store does not serve ranges**, which is the second reason R2 is
 * here. Measured against the deployed review app: a `Range: bytes=0-1023` for
 * this file comes back `200` with all 2.7 MB of it. A browser copes — it
 * buffers the whole track and then seeks locally — but the cutscene overlay
 * drives `currentTime` against a reference clock, so on a slow connection every
 * seek waits for a download that a 206 would have made unnecessary. When a
 * range is asked for and the asset store ignores it, the bucket answers
 * instead.
 */
export async function serveMedia(
  request: Request,
  object: MediaObject,
  stores: MediaStores,
): Promise<Response> {
  const wantsRange = request.headers.has('range')
  const asset = await stores.asset(request)
  const type = asset.headers.get('content-type') ?? ''
  const servedByAssets =
    !type.startsWith('text/html') && !(wantsRange && asset.status === 200)
  if (servedByAssets) return asset

  let stored: StoredObjectBody | StoredObject | null
  try {
    stored = await stores.get(object.key, {
      range: request.headers,
      onlyIf: request.headers,
    })
  } catch {
    /*
     * A `Range` header is client input, and R2 throws on one it cannot satisfy.
     * The answer to bad client input is a 4xx naming the constraint, not a 500
     * — and a 500 here would also be indistinguishable in the logs from the
     * bucket being down.
     *
     * The extra `head` buys the one thing that makes a 416 actionable: the
     * length the caller should have asked within. It is a second round trip on
     * a path nothing reaches unless it asked for bytes that do not exist, and
     * it is allowed to fail — an unsatisfiable range is still unsatisfiable
     * when the bucket will not say how long the object is.
     */
    const meta = await stores.head(object.key).catch(() => null)
    return unsatisfiable(meta?.size)
  }
  if (stored === null) {
    return new Response('not in storage', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const headers = new Headers()
  stored.writeHttpMetadata(headers)
  headers.set('etag', stored.httpEtag)
  headers.set('accept-ranges', 'bytes')
  /*
   * Immutable, and it is true rather than optimistic: the name is an
   * allow-listed constant in `media.ts`, so a *different* track is a different
   * entry and a different URL. This is also what keeps the invocation cost of
   * `run_worker_first` on this path down to roughly one per client.
   */
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  if (!headers.has('content-type')) headers.set('content-type', object.type)

  // No body means R2 answered a conditional request: the client already has it.
  const body = 'body' in stored ? stored.body : null
  if (body === null) return new Response(null, { status: 304, headers })

  /*
   * A 206 only when one was asked for.
   *
   * `stored.range` is populated whether or not the request carried a `Range`
   * header — an unranged get reports the whole object as its range — so keying
   * the status off it alone answers every plain GET with 206 Partial Content.
   * Nothing errors: the bytes are right, and a browser mostly copes. What it
   * breaks is every cache in between, which is entitled to treat a partial
   * response as one it must not reuse as a whole one.
   */
  const range = wantsRange
    ? resolveRange(stored.range ?? {}, stored.size)
    : null
  if (wantsRange && range === null) return unsatisfiable(stored.size)
  if (range === null) {
    headers.set('content-length', String(stored.size))
  } else {
    headers.set('content-range', range.contentRange)
    headers.set('content-length', String(range.length))
  }
  /*
   * The HEAD rule, written once. It used to be written on each of the two
   * branches above, which is one edit away from a HEAD that streams a body and
   * a `Content-Length` nobody reads.
   */
  return new Response(request.method === 'HEAD' ? null : body, {
    status: range === null ? 200 : 206,
    headers,
  })
}

/**
 * 416, for a `Range` that names bytes this object does not have.
 *
 * The alternative — answering 200 — is the bug this replaced: with a range
 * requested, the stored body is the *slice*, so a 200 carrying `content-length:
 * <whole object>` describes a body that is not there. A player reading that
 * waits forever for bytes nobody is going to send.
 */
function unsatisfiable(size?: number): Response {
  return new Response('range not satisfiable', {
    status: 416,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'accept-ranges': 'bytes',
      // RFC 9110: the `*` form is what says "here is the length you should have
      // asked within", and it is the only thing that makes a retry informed.
      ...(size === undefined ? {} : { 'content-range': `bytes */${size}` }),
    },
  })
}
