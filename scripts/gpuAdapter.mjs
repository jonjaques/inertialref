#!/usr/bin/env node
/*
 * The adapter Dawn finds on this machine, before the GPU suite is asked to run.
 *
 *     node scripts/gpuAdapter.mjs          a table per backend, exit 1 if the suite's adapter is software
 *
 * `pnpm test:gpu` fails the same way on a machine with no physical adapter and
 * on one whose adapter is physical and refuses a pipeline: every file at
 * `requestAdapter`, or every file at its first draw. CI (`check.yml`'s `gpu` job,
 * and `gpu-probe.yml` for a Linux runner) needs the two apart, because whether a
 * hosted runner gives Dawn a real device is settled by the first and merely
 * clouded by the second. So this reports what was offered
 * under each backend Dawn was built with, the limits the suite leans on, and
 * whether the adapter the suite gets is a software rasterizer, by the same
 * names and the same fallback flag `gpuHarness.gpu.test.ts` refuses.
 *
 * `webgpu` is `apps/game`'s dependency and pnpm does not hoist it to the root,
 * so it is resolved from that package rather than imported by name here.
 */
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  new URL('../apps/game/package.json', import.meta.url),
)
const { create, globals } = require('webgpu')
Object.assign(globalThis, globals)

// The pattern `gpuHarness.gpu.test.ts` holds the default adapter against.
const SOFTWARE = /mesa|llvmpipe|swiftshader|warp|microsoft basic/i

// The limits a graph here runs into first: the producer binds exactly eight
// storage buffers (design/plans/erosion.md, defect 2), and nothing requests
// more than the default, so the adapter's ceiling is reported beside it.
const LIMITS = [
  'maxStorageBuffersPerShaderStage',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxTextureDimension2D',
  'maxColorAttachmentBytesPerSample',
]

// One `create` per backend: an adapter request cannot name a backend, and a
// backend Dawn was not built with on this platform answers with no adapter
// rather than an error.
const BACKENDS = {
  darwin: ['default', 'metal'],
  linux: ['default', 'vulkan', 'opengles'],
  win32: ['default', 'd3d12', 'vulkan'],
}[process.platform] ?? ['default']

async function describe(backend, powerPreference) {
  const gpu = create(backend === 'default' ? [] : [`backend=${backend}`])
  const adapter = await gpu.requestAdapter({ powerPreference })
  if (adapter === null) return { backend, powerPreference, adapter: null }
  const info = adapter.info ?? {}
  const name = `${info.vendor} ${info.architecture} ${info.device}`
  const fallback = info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null
  return {
    backend,
    powerPreference,
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      // Dawn's own flag first: a CPU adapter under a name the pattern has not
      // met yet is still one, and an empty architecture is legal on a real
      // device (the hosted runner's paravirtual GPU), so it proves nothing.
      software:
        fallback === true || SOFTWARE.test(`${name} ${info.description}`),
      // Blank or absent is a renamed field, not a device: the test fails it.
      named: /\S/.test(info.vendor ?? '') && /\S/.test(info.device ?? ''),
      fallback,
    },
    features: [...adapter.features].sort(),
    limits: Object.fromEntries(LIMITS.map((key) => [key, adapter.limits[key]])),
  }
}

// `undefined` first: it is the request the suite makes, and on a machine with
// two adapters it need not be either of the named preferences' answer.
const PREFERENCES = [undefined, 'high-performance', 'low-power']

const rows = []
for (const backend of BACKENDS) {
  for (const preference of PREFERENCES) {
    try {
      rows.push(await describe(backend, preference))
    } catch (error) {
      rows.push({ backend, powerPreference: preference, error: String(error) })
    }
  }
}

const line = (row) => {
  const preference = row.powerPreference ?? '(none)'
  if (row.error)
    return `| ${row.backend} | ${preference} | error: ${row.error} | | |`
  if (row.adapter === null)
    return `| ${row.backend} | ${preference} | none | | |`
  const a = row.adapter
  const kind = a.software ? 'software' : a.named ? 'physical' : 'unnamed'
  return `| ${row.backend} | ${preference} | ${a.vendor} / ${a.architecture} / ${a.device} — ${a.description} | ${kind} | ${row.limits.maxStorageBuffersPerShaderStage} |`
}
const table = [
  `### Dawn adapters on ${process.platform}-${process.arch}`,
  '',
  '| Backend | Preference | Adapter | Kind | Storage buffers / stage |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(line),
  '',
].join('\n')

console.log(table)
console.log(JSON.stringify(rows, null, 2))
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`)

// The verdict is the default adapter's, because that is the one the suite gets:
// `gpuSetup.ts` calls `create([])` and asks for an adapter with no preference.
const chosen = rows.find(
  (row) => row.backend === 'default' && row.powerPreference === undefined,
)
if (!chosen?.adapter) {
  console.error(
    `gpuAdapter: Dawn offered no adapter under the default backend${chosen?.error ? ` (${chosen.error})` : ''}`,
  )
  process.exit(1)
}
if (!chosen.adapter.named) {
  console.error(
    'gpuAdapter: the default adapter names no vendor or device, which the suite fails',
  )
  process.exit(1)
}
if (chosen.adapter.software) {
  console.error(
    `gpuAdapter: the default adapter is a software rasterizer (${chosen.adapter.description})`,
  )
  process.exit(1)
}
