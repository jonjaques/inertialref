#!/usr/bin/env node
/*
 * The adapter Dawn finds on this machine, before the GPU suite is asked to run.
 *
 *     node scripts/gpuAdapter.mjs          a table per backend, exit 1 if the default is software
 *
 * `pnpm test:gpu` fails the same way on a machine with no physical adapter and
 * on one whose adapter is physical and refuses a pipeline: every file at
 * `requestAdapter`, or every file at its first draw. The probe workflow
 * (`.github/workflows/gpu-probe.yml`) needs the two apart, because the question
 * it answers — does a hosted runner give Dawn a real device — is settled by the
 * first and is merely clouded by the second. So this reports what was offered
 * under each backend Dawn was built with, the limits the suite leans on, and
 * whether the default is a software rasterizer, with the same pattern
 * `gpuHarness.gpu.test.ts` refuses.
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
  return {
    backend,
    powerPreference,
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      software: SOFTWARE.test(`${name} ${info.description}`),
      fallback: adapter.isFallbackAdapter ?? info.isFallbackAdapter ?? null,
    },
    features: [...adapter.features].sort(),
    limits: Object.fromEntries(LIMITS.map((key) => [key, adapter.limits[key]])),
  }
}

const rows = []
for (const backend of BACKENDS) {
  for (const preference of ['high-performance', 'low-power']) {
    try {
      rows.push(await describe(backend, preference))
    } catch (error) {
      rows.push({ backend, powerPreference: preference, error: String(error) })
    }
  }
}

const line = (row) => {
  if (row.error)
    return `| ${row.backend} | ${row.powerPreference} | error: ${row.error} | | |`
  if (row.adapter === null)
    return `| ${row.backend} | ${row.powerPreference} | none | | |`
  const a = row.adapter
  return `| ${row.backend} | ${row.powerPreference} | ${a.vendor} / ${a.architecture} / ${a.device} — ${a.description} | ${a.software ? 'software' : 'physical'} | ${row.limits.maxStorageBuffersPerShaderStage} |`
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
const chosen = rows.find((row) => row.backend === 'default' && row.adapter)
if (!chosen) {
  console.error('gpuAdapter: Dawn offered no adapter under the default backend')
  process.exit(1)
}
if (chosen.adapter.software) {
  console.error(
    `gpuAdapter: the default adapter is a software rasterizer (${chosen.adapter.description})`,
  )
  process.exit(1)
}
