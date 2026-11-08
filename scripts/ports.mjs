import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createConnection } from 'node:net'

/*
 * One port allocator for every rig: the dev server, the driver's Chrome, a
 * preview, a base tree, a bisect step and a static server.
 *
 * A fixed port is what parallel worktrees fight over. A foreign Vite answers
 * on it and is taken for this tree's server; another agent's Chrome holds it.
 * So a tree's port in a role is the role's base plus a hash of the tree root,
 * mod SPAN: stable for the tree, different between trees.
 *
 * A hash alone collides. With 200 slots, two trees share one 0.5% of the time,
 * six cut together 7.3%, and a checkout with nineteen worktrees 58.6%. Probing
 * cannot settle a collision between two trees started at once, because neither
 * has bound when the other looks. So the core reads every worktree git lists,
 * orders them by path, and lets each claim the first free port from its own
 * offset in that order. Every worktree reads the same list and reaches the same
 * plan without seeing a socket. The probe covers the rest: a clone git does not
 * list, a server that is not a rig's, and a server bound before a new worktree
 * reordered the plan.
 *
 * The core (`portFor`, `candidates`) is pure: the answer is a function of the
 * role, the tree, the worktree list and the set of taken ports. The shell
 * (`freePort`) asks git for the trees and the sockets for the taken ports.
 */

export const SPAN = 200

/*
 * One band, 16000–17199, a role to each SPAN of it. Below 32768, so neither
 * Linux's ephemeral range (32768–60999) nor macOS's (49152–65535) lends a
 * client socket a candidate. Above every bad port, whose highest is 10080, and
 * clear of every port the repository binds by name: 5173, 5183, 5184, 8787,
 * 9229, 9230 and 9333.
 */
export const ROLES = Object.freeze({
  vite: 16000, // a worktree's own dev server, beside `pnpm dev`'s 5173
  drive: 16200, // the driver's Chrome: its CDP port, which keys its profile
  preview: 16400, // `astro preview` over a built tree
  base: 16600, // the baseline tree a comparison serves
  bisect: 16800, // the tree a bisect step serves
  static: 17000, // a plain file server
})

/*
 * `pnpm dev`'s Vite and Worker, and the driver's default Chrome. The band
 * never reaches them; the walk refuses them anyway, so moving a base cannot
 * hand one out.
 */
export const RESERVED = Object.freeze([5173, 8787, 9333])

/*
 * The Fetch standard's bad ports, https://fetch.spec.whatwg.org/#port-blocking
 * (Living Standard, last updated 19 October 2026). A browser refuses to fetch
 * from one before it sends anything, so a server there reads to the driver as
 * nothing serving.
 */
export const BAD_PORTS = Object.freeze([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
])

const BLOCKED = new Set([...RESERVED, ...BAD_PORTS])

/** The ports a role may hand out, `first` to `last` inclusive. */
export function rangeOf(role) {
  if (!Object.hasOwn(ROLES, role))
    throw new Error(
      `Unknown port role "${role}"; the roles are ${Object.keys(ROLES).join(', ')}.`,
    )
  const first = ROLES[role]
  return { first, last: first + SPAN - 1 }
}

function offsetOf(tree) {
  if (typeof tree !== 'string' || tree === '')
    throw new Error('A tree root is a non-empty path.')
  return createHash('sha256').update(tree).digest().readUInt32BE(0) % SPAN
}

/** Every unblocked port in the range, from the tree's offset, wrapping. */
function* walk(role, tree) {
  const { first } = rangeOf(role)
  const start = offsetOf(tree)
  for (let i = 0; i < SPAN; i++) {
    const port = first + ((start + i) % SPAN)
    if (!BLOCKED.has(port)) yield port
  }
}

/*
 * The port each tree holds when all of them start at once. Code-unit order of
 * the path decides a collision, because it is the one order every tree
 * computes identically from the same list.
 */
function plan(role, trees) {
  const claims = new Map()
  const claimed = new Set()
  for (const tree of [...new Set(trees)].sort()) {
    for (const port of walk(role, tree)) {
      if (claimed.has(port)) continue
      claims.set(tree, port)
      claimed.add(port)
      break
    }
  }
  return claims
}

/**
 * A tree's ports in a role, in the order it tries them: its own claim first,
 * then the rest of the range, never a port another listed tree claims.
 */
export function* candidates(role, tree, { trees = [] } = {}) {
  const others = new Set()
  for (const [other, port] of plan(role, [...trees, tree]))
    if (other !== tree) others.add(port)
  for (const port of walk(role, tree)) if (!others.has(port)) yield port
}

function exhausted(role) {
  const { first, last } = rangeOf(role)
  return new Error(
    `Every ${role} port in ${first}–${last} is taken or reserved, or claimed by another worktree.`,
  )
}

/**
 * The port `tree` binds in `role`, given every worktree root git lists and the
 * ports already taken. The same inputs give the same port on every machine.
 */
export function portFor(role, tree, { trees = [], taken = [] } = {}) {
  const held = new Set(taken)
  for (const port of candidates(role, tree, { trees }))
    if (!held.has(port)) return port
  throw exhausted(role)
}

// ── The shell ────────────────────────────────────────────────────────────────

/*
 * Both loopbacks, because Astro binds `::1` alone and an IPv4 probe reads its
 * port as free (`dev.mjs` meets the same thing on 5173).
 */
const LOOPBACK = Object.freeze(['127.0.0.1', '::1'])
const PROBE_MS = 1000

/*
 * A connect, not a bind. BSD lets a bind to 127.0.0.1 or ::1 succeed beside a
 * wildcard listener on the same port: on macOS 27.2 with Node 26, both binds
 * succeed against a 0.0.0.0 or a :: listener. A bind probe would pass a port a
 * `--host` dev server holds. A loopback connect is refused at once where
 * nothing listens, and fails at once where the family is absent, as `::1` is
 * in some CI containers. One that does neither is not a port to hand out.
 */
function accepts(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(PROBE_MS)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** Whether anything accepts on `port` at any of `hosts`. */
export async function listening(port, hosts = LOOPBACK) {
  const answers = await Promise.all(hosts.map((host) => accepts(host, port)))
  return answers.includes(true)
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/*
 * The hash reads a spelling, not a directory, so both roots go through
 * realpath: a root reached through a symlink would otherwise be a second tree.
 * A worktree whose directory is gone keeps the spelling git recorded.
 */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The root of the tree `cwd` is in: `git rev-parse --show-toplevel`. */
export function treeRoot(cwd = process.cwd()) {
  return canonical(git(['rev-parse', '--show-toplevel'], cwd).trim())
}

/** Every worktree of the repository `cwd` is in, the main checkout included. */
export function worktreeRoots(cwd = process.cwd()) {
  return git(['worktree', 'list', '--porcelain', '-z'], cwd)
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => canonical(field.slice('worktree '.length)))
}

/**
 * The first of this tree's candidates in `role` that nothing listens on, on
 * either loopback. The answer is `portFor` with the probed ports as `taken`.
 */
export async function freePort(
  role,
  {
    cwd = process.cwd(),
    tree = treeRoot(cwd),
    trees = worktreeRoots(cwd),
  } = {},
) {
  for (const port of candidates(role, tree, { trees }))
    if (!(await listening(port))) return port
  throw exhausted(role)
}
