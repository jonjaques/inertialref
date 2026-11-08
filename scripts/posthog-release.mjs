#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/*
 * PostHog's half of a production deploy, run by `apps/server`'s `deploy`
 * script on each side of `cf deploy` (docs/hosting.md § Environments,
 * deployment and secrets).
 *
 *   --release   Before the deploy: the error-tracking release this build's
 *               exceptions resolve to. PostHog caches a release lookup for
 *               five minutes, a miss included, so a release created after the
 *               bundle is live leaves its first five minutes of exceptions
 *               attached to none.
 *   --annotate  After it: a marker on every chart at the moment it went live.
 *
 * Neither may fail a deploy. Without `POSTHOG_RELEASE_KEY` or a commit it says
 * so in one line and sends nothing, which is every preview, every fork and
 * every deploy from a terminal. Anything that goes wrong after that is a
 * warning, and the exit status is 0 whatever happened: a deploy that could not
 * reach PostHog is still a deploy.
 *
 * The key is a PostHog personal API key with `error_tracking:write` and
 * `annotation:write`, a Production build secret in Workers Builds. It is never
 * printed.
 */

/** PostHog's private API, US Cloud. */
const APP_HOST = 'https://us.posthog.com'

/**
 * `$app_namespace` on every exception the browser reports. A release belongs
 * to an exception when this and the version both match.
 */
export const NAMESPACE = 'inertialref'

const TIMEOUT_MS = 15_000

/** Branch names carry slashes; the same rule `vite.config.ts` applies. */
const slug = (text) => text.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)

/**
 * The build id a Workers Builds build stamps into the bundle, which the
 * browser reports as `$app_version`.
 *
 * This is the Workers Builds branch of `buildId()` in `apps/game/vite.config.ts`,
 * mirrored because loading that file loads Vite and every plugin it configures.
 * The two must agree character for character: a version that differs by one
 * names a release no exception will ever carry. Change both or neither;
 * `posthog-release.test.mjs` holds this half to the rule.
 */
export function buildVersion(sha, branch) {
  const short = sha.slice(0, 8)
  return branch === '' || branch === 'main' ? short : `${slug(branch)}@${short}`
}

/**
 * The release's `hash_id`: SHA-512, in hex, of the namespace followed by the
 * version, which is what PostHog's own CLI computes (`content_hash` over
 * `[name, version]`) and so what a lookup by namespace and version finds.
 */
export const releaseHash = (version) =>
  createHash('sha512').update(NAMESPACE).update(version).digest('hex')

/*
 * The two request bodies, here and nowhere else. Neither shape is documented
 * for this use. The release's is read from PostHog's server
 * (`ErrorTrackingReleaseViewSet.create`, which requires `version` and
 * `project`) and its CLI (`cli/src/api/releases.rs`, which adds `hash_id` and
 * `metadata.git`), at PostHog/posthog@0f072f8. The annotation's `scope` is
 * required in practice: without `"project"` the marker attaches to no chart.
 */
export function releaseBody({ sha, branch }) {
  const version = buildVersion(sha, branch)
  return {
    hash_id: releaseHash(version),
    version,
    project: NAMESPACE,
    metadata: { git: { commit_id: sha, branch } },
  }
}

export function annotationBody({ sha, branch, now }) {
  const short = sha.slice(0, 8)
  return {
    content:
      branch === '' ? `Release ${short}` : `Release ${short} (${branch})`,
    date_marker: now.toISOString(),
    scope: 'project',
    creation_type: 'GIT',
  }
}

const PATHS = {
  release: 'error_tracking/releases/',
  annotate: 'annotations/',
}

/** The request one mode sends: where, with what, carrying which body. */
export function request(mode, { projectId, key, ...build }) {
  return {
    url: `${APP_HOST}/api/projects/${encodeURIComponent(projectId)}/${PATHS[mode]}`,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        mode === 'release' ? releaseBody(build) : annotationBody(build),
      ),
    },
  }
}

/**
 * What this deploy gives the step, or why it sends nothing. The project id is
 * optional here: without it the step reads the one the Worker declares.
 */
export function inputs(env, now) {
  const key = env.POSTHOG_RELEASE_KEY ?? ''
  const sha = env.WORKERS_CI_COMMIT_SHA ?? ''
  if (key === '') return { skip: 'no POSTHOG_RELEASE_KEY' }
  if (sha === '') return { skip: 'no WORKERS_CI_COMMIT_SHA' }
  return {
    key,
    sha,
    branch: env.WORKERS_CI_BRANCH ?? '',
    projectId: env.POSTHOG_PROJECT_ID ?? '',
    now,
  }
}

/**
 * The line PostHog's answer becomes, and whether it is a warning. A release
 * that already exists is the same commit deployed twice — a rebuild — and is
 * not one: the server refuses a second release with that hash
 * (`release_hash_in_use`), and the CLI reads that refusal as success.
 */
export function verdict(mode, status, body) {
  if (status === 201 || status === 200)
    return {
      warn: false,
      line: mode === 'release' ? 'release recorded' : 'deploy annotated',
    }
  if (
    mode === 'release' &&
    status === 400 &&
    body?.code === 'release_hash_in_use'
  )
    return { warn: false, line: 'release already recorded' }
  const detail =
    typeof body?.detail === 'string' ? `: ${body.detail.slice(0, 200)}` : ''
  return { warn: true, line: `PostHog answered ${status}${detail}` }
}

/** The project id `apps/server/cloudflare.config.ts` declares for the Worker. */
async function declaredProjectId() {
  const { default: config } =
    await import('../apps/server/cloudflare.config.ts')
  return config({ isPreview: false, mode: 'production' }).worker.env
    .POSTHOG_PROJECT_ID.value
}

/** One step. Resolves whatever happens; a failure is a warning, never a throw. */
export async function run(argv, env, now = new Date()) {
  const say = (line, warn = false) =>
    (warn ? console.warn : console.log)(`posthog-release: ${line}`)
  try {
    const mode = argv.includes('--release')
      ? 'release'
      : argv.includes('--annotate')
        ? 'annotate'
        : null
    if (mode === null)
      return say('pass --release or --annotate; sent nothing', true)
    const given = inputs(env, now)
    if ('skip' in given) return say(`${given.skip}, so no ${mode} was sent`)
    const projectId = given.projectId || (await declaredProjectId())
    const { url, init } = request(mode, { ...given, projectId })
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null)
    const { warn, line } = verdict(mode, response.status, body)
    say(`${line} (${buildVersion(given.sha, given.branch)})`, warn)
  } catch (error) {
    say(
      `${error instanceof Error ? error.message : String(error)}; the deploy goes on`,
      true,
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run(process.argv.slice(2), process.env)
  process.exitCode = 0
}
