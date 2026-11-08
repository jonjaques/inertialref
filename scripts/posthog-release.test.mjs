import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../apps/server/cloudflare.config.ts'
import {
  annotationBody,
  buildVersion,
  inputs,
  NAMESPACE,
  releaseBody,
  releaseHash,
  request,
  run,
  verdict,
} from './posthog-release.mjs'

const SHA = '0123abcd89ef0123abcd89ef0123abcd89ef0123'
const NOW = new Date('2026-11-07T18:00:00.000Z')

/*
 * `buildId()` and `slug` exactly as `apps/game/vite.config.ts` has them, cut
 * out of its source and run with Workers Builds' variables. Loading the
 * config itself would load Vite and its plugins; this loads the two
 * functions the release version has to agree with, and nothing else.
 */
function viteBuildId() {
  const source = readFileSync(
    new URL('../apps/game/vite.config.ts', import.meta.url),
    'utf8',
  )
  const cut = (start, end) => {
    const from = source.indexOf(start)
    const to = source.indexOf(end, from)
    expect(from, start).toBeGreaterThan(-1)
    expect(to, start).toBeGreaterThan(from)
    return source.slice(from, to + end.length)
  }
  const body = stripTypeScriptTypes(
    `${cut('function buildId(', '\n}\n')}${cut('const slug =', '\n\n')}`,
  )
  // oxlint-disable-next-line no-new-func -- the point is to run the file's own text
  const make = new Function('process', 'execSync', `${body}\nreturn buildId`)
  return (sha, branch) =>
    make(
      { env: { WORKERS_CI_COMMIT_SHA: sha, WORKERS_CI_BRANCH: branch } },
      () => {
        throw new Error('a Workers Builds build never asks git')
      },
    )()
}

describe('the release version', () => {
  it('is the build id vite.config.ts stamps into the bundle', () => {
    const vite = viteBuildId()
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.oneof(
          fc.constant('main'),
          fc.constant(''),
          fc.string(),
          fc.stringMatching(/^[a-z]+\/[a-z0-9 ._/-]{0,60}$/),
        ),
        (sha, branch) => buildVersion(sha, branch) === vite(sha, branch),
      ),
    )
  })

  it('is the short commit on main, and branch@commit elsewhere', () => {
    expect(buildVersion(SHA, 'main')).toBe('0123abcd')
    expect(buildVersion(SHA, '')).toBe('0123abcd')
    expect(buildVersion(SHA, 'feat/telemetry worker')).toBe(
      'feat-telemetry-worker@0123abcd',
    )
  })

  it("is hashed the way PostHog's CLI hashes a release", () => {
    // `printf 'inertialref0123abcd' | shasum -a 512`, outside Node.
    expect(releaseHash('0123abcd')).toBe(
      'a0b62f260d81043320f8a223fcfa89bfd3e9341c3b6dd14e7c344dab5a16a04aedc2da8eabe9db521db86559821118d34f2f88bbdab1df76a42a4ced13ce6b08',
    )
  })
})

describe('the requests', () => {
  const given = {
    projectId: '719084',
    key: 'phx_canary',
    sha: SHA,
    branch: 'main',
    now: NOW,
  }

  it('records the release under the namespace the browser reports', () => {
    expect(releaseBody(given)).toEqual({
      hash_id: releaseHash('0123abcd'),
      version: '0123abcd',
      project: NAMESPACE,
      metadata: { git: { commit_id: SHA, branch: 'main' } },
    })
    const { url, init } = request('release', given)
    expect(url).toBe(
      'https://us.posthog.com/api/projects/719084/error_tracking/releases/',
    )
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: 'Bearer phx_canary',
      'content-type': 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual(releaseBody(given))
  })

  it('annotates every chart, at the moment of the deploy', () => {
    expect(annotationBody(given)).toEqual({
      content: 'Release 0123abcd (main)',
      date_marker: '2026-11-07T18:00:00.000Z',
      scope: 'project',
      creation_type: 'GIT',
    })
    const { url, init } = request('annotate', given)
    expect(url).toBe('https://us.posthog.com/api/projects/719084/annotations/')
    expect(JSON.parse(init.body)).toEqual(annotationBody(given))
  })

  it('takes its project from the deploy, or from what the Worker declares', () => {
    expect(
      inputs({ POSTHOG_RELEASE_KEY: 'k', WORKERS_CI_COMMIT_SHA: SHA }, NOW),
    ).toEqual({
      key: 'k',
      sha: SHA,
      branch: '',
      projectId: '',
      now: NOW,
    })
    const declared = config({ isPreview: false, mode: 'production' }).worker.env
    expect(declared.POSTHOG_PROJECT_ID.value).toBe('719084')
    // Production's alone, so a preview's upload never waits on them.
    expect(declared.CLERK_WEBHOOK_SIGNING_SECRET).toBeUndefined()
    expect(declared.POSTHOG_PERSON_DELETE_KEY).toBeUndefined()
  })

  it('sends nothing without a key or a commit', () => {
    expect(inputs({ WORKERS_CI_COMMIT_SHA: SHA }, NOW)).toEqual({
      skip: 'no POSTHOG_RELEASE_KEY',
    })
    expect(inputs({ POSTHOG_RELEASE_KEY: 'k' }, NOW)).toEqual({
      skip: 'no WORKERS_CI_COMMIT_SHA',
    })
  })

  it('reads a release that already exists as recorded', () => {
    expect(verdict('release', 201, {})).toEqual({
      warn: false,
      line: 'release recorded',
    })
    expect(
      verdict('release', 400, {
        type: 'validation_error',
        code: 'release_hash_in_use',
      }),
    ).toEqual({ warn: false, line: 'release already recorded' })
    expect(
      verdict('release', 400, {
        code: 'invalid_input',
        detail: 'Version is required',
      }),
    ).toEqual({
      warn: true,
      line: 'PostHog answered 400: Version is required',
    })
    expect(verdict('annotate', 403, null)).toEqual({
      warn: true,
      line: 'PostHog answered 403',
    })
  })
})

describe('a deploy step', () => {
  const env = {
    POSTHOG_RELEASE_KEY: 'phx_canary',
    WORKERS_CI_COMMIT_SHA: SHA,
    WORKERS_CI_BRANCH: 'main',
  }
  const posthog = vi.fn()
  beforeEach(() => {
    posthog.mockReset()
    vi.stubGlobal('fetch', posthog)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const printed = () =>
    JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
    ])

  it('is wired on both sides of cf deploy', () => {
    const { scripts } = JSON.parse(
      readFileSync(
        new URL('../apps/server/package.json', import.meta.url),
        'utf8',
      ),
    )
    expect(scripts.deploy).toBe(
      'node ../../scripts/posthog-release.mjs --release && cf deploy --mode production && node ../../scripts/posthog-release.mjs --annotate',
    )
  })

  it('sends one request, with the declared project when the deploy names none', async () => {
    posthog.mockResolvedValue(Response.json({ id: 'r' }, { status: 201 }))
    await run(['--release'], env, NOW)
    expect(posthog).toHaveBeenCalledOnce()
    expect(posthog.mock.calls[0][0]).toBe(
      'https://us.posthog.com/api/projects/719084/error_tracking/releases/',
    )
    expect(console.log).toHaveBeenCalledWith(
      'posthog-release: release recorded (0123abcd)',
    )
  })

  it('says it sent nothing, in one line, without a key', async () => {
    await run(['--annotate'], { WORKERS_CI_COMMIT_SHA: SHA }, NOW)
    expect(posthog).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledOnce()
    expect(console.log).toHaveBeenCalledWith(
      'posthog-release: no POSTHOG_RELEASE_KEY, so no annotate was sent',
    )
  })

  it('never throws, and never prints the key', async () => {
    posthog.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(run(['--release'], env, NOW)).resolves.toBeUndefined()
    posthog.mockResolvedValueOnce(
      new Response('<html>bad gateway</html>', { status: 502 }),
    )
    await expect(run(['--annotate'], env, NOW)).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(
      'posthog-release: fetch failed; the deploy goes on',
    )
    expect(console.warn).toHaveBeenCalledWith(
      'posthog-release: PostHog answered 502 (0123abcd)',
    )
    expect(printed()).not.toContain('phx_canary')
  })
})
