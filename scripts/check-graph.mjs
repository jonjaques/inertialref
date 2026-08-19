#!/usr/bin/env node
/*
 * Dependency layering check.
 *
 * TypeScript project references would enforce this, but a referenced project
 * may not disable emit, and declaration-emitting eleven source-only packages to
 * satisfy `tsc -b` buys nothing. This does the same job in 80 lines, with a
 * better error message, and additionally enforces the *layering* — not just the
 * absence of cycles, but that foundational packages stay foundational.
 *
 * Each package declares `inertialref.layer` in its package.json. A package may
 * only depend on strictly lower layers.
 *
 * It also enforces the rule that `packages/*` carries no third-party runtime
 * dependency at all. That is the mechanical form of "no hosting vendor's SDK
 * below the adapter layer": the core has to run unchanged in a browser, a worker
 * and Node, and the cheapest way to guarantee it is to let it depend on nothing
 * but itself. The layering check alone could not catch this — it discarded every
 * non-workspace edge before looking — so the invariant was documented as
 * enforced while nothing enforced it.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packagesDir = join(root, 'packages')

const packages = new Map()
for (const name of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, name, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    continue
  }
  const allDeps = Object.keys(manifest.dependencies ?? {})
  packages.set(manifest.name, {
    name: manifest.name,
    layer: manifest.inertialref?.layer,
    deps: allDeps.filter((dep) => dep.startsWith('@inertialref/')),
    foreign: allDeps.filter((dep) => !dep.startsWith('@inertialref/')),
  })
}

const problems = []

for (const pkg of packages.values()) {
  if (pkg.foreign.length > 0) {
    problems.push(
      `${pkg.name} depends on ${pkg.foreign.join(', ')}; packages/* must have no ` +
        `third-party runtime dependency (see the header of this script)`,
    )
  }
  if (typeof pkg.layer !== 'number') {
    problems.push(`${pkg.name} has no inertialref.layer in its package.json`)
    continue
  }
  for (const dep of pkg.deps) {
    const target = packages.get(dep)
    if (target === undefined) {
      problems.push(`${pkg.name} depends on ${dep}, which is not a workspace package`)
      continue
    }
    if (typeof target.layer !== 'number') continue
    if (target.layer >= pkg.layer) {
      problems.push(
        `${pkg.name} (layer ${pkg.layer}) depends on ${dep} (layer ${target.layer}); ` +
          `dependencies must sit strictly lower`,
      )
    }
  }
}

// Cycle detection, independent of the layer declarations, so a wrong layer
// number cannot hide a real cycle.
const state = new Map()
const stack = []
function visit(name) {
  const status = state.get(name)
  if (status === 'done') return
  if (status === 'visiting') {
    problems.push(`dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' → ')}`)
    return
  }
  state.set(name, 'visiting')
  stack.push(name)
  for (const dep of packages.get(name)?.deps ?? []) visit(dep)
  stack.pop()
  state.set(name, 'done')
}
for (const name of packages.keys()) visit(name)

if (problems.length > 0) {
  console.error('Dependency graph problems:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const byLayer = new Map()
for (const pkg of packages.values()) {
  byLayer.set(pkg.layer, [...(byLayer.get(pkg.layer) ?? []), pkg.name.replace('@inertialref/', '')])
}
for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
  console.log(`layer ${layer}: ${byLayer.get(layer).sort().join(', ')}`)
}
console.log(`${packages.size} packages, no cycles, layering intact, no third-party dependencies`)
