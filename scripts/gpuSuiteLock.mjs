/*
 * `pnpm test:gpu`'s hold on the machine's GPU lock.
 *
 * vitest's `globalSetup` for `apps/game/vitest.gpu.config.ts`. It runs once,
 * in vitest's main process, before any worker exists and so before any test
 * file has created a Dawn device; the teardown it returns runs after the last
 * file has finished. A refusal therefore costs no adapter request, and names
 * the job that has the GPU — a drive.mjs rig, a preset command, another
 * worktree's suite — before a line of a test has run.
 *
 * The holder is the main process, and the devices are in its fork workers,
 * which outlive a SIGTERM or a SIGKILL of it by seconds. So the lock is taken
 * with `keepChildren`: ended by a signal, or by an exit before the teardown,
 * the main process leaves the lock to the workers still running. A SIGKILL
 * runs nothing, and leaves the workers unrecorded.
 */
import { acquire, parseWait } from './gpuLock.mjs'

/**
 * A bounded wait for the lock, in seconds: `IR_GPU_WAIT=120 pnpm test:gpu`.
 * An environment variable because vitest owns this command's flags, and the
 * name drive.mjs's `--gpu-wait` would have. It is a wait and never a bypass:
 * when it runs out the suite is refused like any other job.
 */
const WAIT_ENV = 'IR_GPU_WAIT'

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.path]  the lock file; the shared one by default
 * @param {(line: string) => void} [options.say]  where a queued wait reports
 * @returns {Promise<() => void>} the teardown, which releases it
 */
export async function holdForSuite({ env = process.env, path, say } = {}) {
  const lock = await acquire('test:gpu', {
    waitMs: parseWait(env[WAIT_ENV], WAIT_ENV),
    path,
    keepChildren: true,
    hint: `${WAIT_ENV}=<seconds> pnpm test:gpu queues for it.`,
    say,
  })
  return () => lock.release()
}

export default () => holdForSuite()
