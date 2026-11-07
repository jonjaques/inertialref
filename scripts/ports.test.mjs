import fc from 'fast-check'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BAD_PORTS,
  RESERVED,
  ROLES,
  SPAN,
  candidates,
  freePort,
  listening,
  portFor,
  rangeOf,
  treeRoot,
  worktreeRoots,
} from './ports.mjs'

const ROLE_NAMES = Object.keys(ROLES)
const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))

const anyRole = fc.constantFrom(...ROLE_NAMES)
const anyTree = fc
  .array(fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/), {
    minLength: 1,
    maxLength: 6,
  })
  .map((segments) => `/${segments.join('/')}`)

/** Two tree roots that hash to one offset, found by search so the pair is fixed. */
function collidingPair() {
  const seen = new Map()
  for (let i = 0; ; i++) {
    const tree = `/work/inertialref/.claude/worktrees/wf-${i}`
    const port = portFor('vite', tree)
    if (seen.has(port)) return [seen.get(port), tree].sort()
    seen.set(port, tree)
  }
}

/** A tree whose own port in `role` is the last one in the range. */
function treeAtEndOf(role) {
  const { last } = rangeOf(role)
  for (let i = 0; ; i++) {
    const tree = `/work/edge-${i}`
    if (portFor(role, tree) === last) return tree
  }
}

function listenOn(host, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host, port, exclusive: true }, () => resolve(server))
  })
}

const close = (server) => new Promise((resolve) => server.close(resolve))
const portOf = (server) => server.address().port

/*
 * Whether this host has an IPv6 loopback at all. Some CI containers start
 * without one, and there `::1` cannot be bound by anything, so the half of the
 * probe that asks it has nothing to find.
 */
const ipv6Missing = await listenOn('::1').then(
  async (server) => {
    await close(server)
    return null
  },
  (error) => error.code,
)

describe('the role ranges', () => {
  it('are SPAN wide, one per role, and disjoint', () => {
    const ranges = ROLE_NAMES.map(rangeOf)
    for (const { first, last } of ranges) expect(last - first + 1).toBe(SPAN)
    for (const [i, a] of ranges.entries())
      for (const b of ranges.slice(i + 1))
        expect(a.last < b.first || b.last < a.first).toBe(true)
  })

  it('sit below every ephemeral range and above the privileged ports', () => {
    // Linux hands outbound sockets 32768–60999 and macOS 49152–65535, so a
    // range above 32768 could find a candidate squatted by a client socket.
    for (const role of ROLE_NAMES) {
      expect(rangeOf(role).first).toBeGreaterThan(1023)
      expect(rangeOf(role).last).toBeLessThan(32768)
    }
  })

  it('refuses a role it does not know, naming the ones it does', () => {
    expect(() => portFor('vitest', '/work/a')).toThrow(
      'the roles are vite, drive, preview, base, bisect, static',
    )
  })

  it('refuses an empty tree root, which every caller would hash alike', () => {
    expect(() => portFor('vite', '')).toThrow('A tree root is a non-empty path')
    expect(() => portFor('vite', '/work/a', { trees: [''] })).toThrow(
      'A tree root is a non-empty path',
    )
  })
})

describe('portFor, the pure core', () => {
  it('stays inside the role range and off the reserved, bad and taken ports (property)', () => {
    const blocked = new Set([...RESERVED, ...BAD_PORTS])
    fc.assert(
      fc.property(
        anyRole,
        anyTree,
        fc.uniqueArray(anyTree, { maxLength: 8 }),
        fc.uniqueArray(fc.nat(SPAN - 1), { maxLength: 60 }),
        (role, tree, trees, offsets) => {
          const { first, last } = rangeOf(role)
          const taken = offsets.map((offset) => first + offset)
          const port = portFor(role, tree, { trees, taken })
          expect(port).toBeGreaterThanOrEqual(first)
          expect(port).toBeLessThanOrEqual(last)
          expect(blocked.has(port)).toBe(false)
          expect(taken).not.toContain(port)
        },
      ),
    )
  })

  it('tries every port of the range once, except the reserved and bad ones', () => {
    // The whole walk, not a sample: a base moved onto 5173 or 6000 puts the
    // port in the range, and only the filter keeps it out of this list.
    const blocked = new Set([...RESERVED, ...BAD_PORTS])
    for (const role of ROLE_NAMES) {
      const { first, last } = rangeOf(role)
      const open = []
      for (let port = first; port <= last; port++)
        if (!blocked.has(port)) open.push(port)
      const ports = [...candidates(role, '/work/a')]
      expect([...ports].sort((a, b) => a - b)).toEqual(open)
    }
  })

  it('is one answer however the worktree list is ordered, and whether it names the asking tree (property)', () => {
    fc.assert(
      fc.property(
        anyRole,
        anyTree,
        fc.uniqueArray(anyTree, { maxLength: 12 }),
        (role, tree, trees) => {
          const port = portFor(role, tree, { trees })
          expect(portFor(role, tree, { trees: [...trees].reverse() })).toBe(
            port,
          )
          expect(portFor(role, tree, { trees: [tree, ...trees] })).toBe(port)
        },
      ),
    )
  })

  it('puts a lone tree at the same offset in every role', () => {
    const offsets = ROLE_NAMES.map(
      (role) => portFor(role, '/work/a') - rangeOf(role).first,
    )
    expect(new Set(offsets).size).toBe(1)
  })

  it('moves a taken port to the next candidate, wrapping inside the range', () => {
    const tree = treeAtEndOf('static')
    const { first, last } = rangeOf('static')
    expect(portFor('static', tree, { taken: [last] })).toBe(first)
    expect(portFor('static', tree, { taken: [last, first] })).toBe(first + 1)
  })

  it('refuses when every port in the range is taken', () => {
    const { first } = rangeOf('bisect')
    const taken = Array.from({ length: SPAN }, (_, i) => first + i)
    expect(() => portFor('bisect', '/work/a', { taken })).toThrow(
      `Every bisect port in ${first}–${first + SPAN - 1} is taken or reserved`,
    )
  })
})

describe('worktrees started at once', () => {
  it('get disjoint ports in every role, even when their hashes collide', () => {
    const [earlier, later] = collidingPair()
    const trees = [earlier, later]
    for (const role of ROLE_NAMES) {
      // Alone, both trees want one port: the collision is real.
      expect(portFor(role, earlier)).toBe(portFor(role, later))
      const [own, next] = candidates(role, later)
      // The tree first by path keeps it, and the other takes the next one,
      // without either having probed a socket the other bound.
      expect(portFor(role, earlier, { trees })).toBe(own)
      expect(portFor(role, later, { trees })).toBe(next)
    }
  })

  it('get pairwise-disjoint ports from the same list, read in any order (property)', () => {
    fc.assert(
      fc.property(
        anyRole,
        fc.uniqueArray(anyTree, { minLength: 2, maxLength: 24 }),
        (role, trees) => {
          const ports = trees.map((tree, i) =>
            portFor(role, tree, {
              trees: [...trees.slice(i), ...trees.slice(0, i)],
            }),
          )
          expect(new Set(ports).size).toBe(trees.length)
        },
      ),
    )
  })
})

describe('the shell, against real listeners', () => {
  it('reads a port held on 127.0.0.1 as taken, and free once it closes', async () => {
    const server = await listenOn('127.0.0.1')
    const port = portOf(server)
    expect(await listening(port)).toBe(true)
    await close(server)
    expect(await listening(port)).toBe(false)
  })

  it('reads a port held on ::1 alone as taken, which an IPv4 probe misses', async (context) => {
    context.skip(
      ipv6Missing !== null,
      `IPv6 loopback is unavailable here (binding ::1 failed with ${ipv6Missing}), as in some CI containers`,
    )
    const server = await listenOn('::1')
    const port = portOf(server)
    try {
      expect(await listening(port, ['127.0.0.1'])).toBe(false)
      expect(await listening(port)).toBe(true)
    } finally {
      await close(server)
    }
  })

  it('reads a port a wildcard listener holds as taken', async () => {
    // BSD lets a bind to 127.0.0.1 succeed beside a 0.0.0.0 listener on the
    // same port, so this is the case a bind probe would pass.
    const server = await listenOn('0.0.0.0')
    try {
      expect(await listening(portOf(server))).toBe(true)
    } finally {
      await close(server)
    }
  })

  it('hands out the next candidate past a port a real listener holds', async () => {
    // Anything on this machine may hold a port in the band, so the tree is one
    // whose own port is bindable here; the search keeps it deterministic.
    for (let i = 0; i < 50; i++) {
      const tree = `/work/shell-${i}`
      const port = portFor('static', tree)
      const server = await listenOn('127.0.0.1', port).catch(() => null)
      if (server === null) continue
      try {
        expect(await freePort('static', { tree, trees: [] })).toBe(
          portFor('static', tree, { taken: [port] }),
        )
      } finally {
        await close(server)
      }
      return
    }
    throw new Error('No tree in 50 had a bindable static port.')
  })

  it('reads this checkout and its worktrees from git', async () => {
    expect(treeRoot(ROOT)).toBe(ROOT)
    expect(worktreeRoots(ROOT)).toContain(ROOT)
    const port = await freePort('bisect', { cwd: ROOT })
    expect(port).toBeGreaterThanOrEqual(rangeOf('bisect').first)
    expect(port).toBeLessThanOrEqual(rangeOf('bisect').last)
    expect(await listening(port)).toBe(false)
  })
})
