import { describe, expect, it } from 'vitest'
import { outputFile, previewRecord } from './previews-deploy.mjs'

const NOW = new Date('2026-09-30T03:48:00.979Z')

/** What `cf previews deploy` prints to stdout: its build steps, then the record. */
const printed = (color = (key) => key) =>
  [
    '├  Build',
    '│  Delegating to Wrangler',
    '◆  Build complete',
    '{',
    `  ${color('"type"')}: "preview",`,
    `  ${color('"version"')}: 1,`,
    `  ${color('"preview_id"')}: "84257cc8c852403888a63c23a50cb4ac",`,
    `  ${color('"preview_name"')}: "fix/some-branch",`,
    `  ${color('"preview_slug"')}: "fix-some-branch",`,
    `  ${color('"preview_urls"')}: [`,
    '    "https://fix-some-branch-inertialrefd.example.workers.dev"',
    '  ],',
    `  ${color('"deployment_id"')}: "6f4756b8-cc38-4764-a1e0-c4f9efd3103d",`,
    `  ${color('"deployment_urls"')}: [`,
    '    "https://6f4756b8-inertialrefd.example.workers.dev"',
    '  ]',
    '}',
    '',
  ].join('\n')

describe('the preview record Workers Builds reads', () => {
  it('is the record cf printed, completed the way wrangler preview writes it', () => {
    expect(previewRecord(printed(), 'inertialrefd', NOW)).toEqual({
      type: 'preview',
      version: 1,
      worker_name: 'inertialrefd',
      preview_id: '84257cc8c852403888a63c23a50cb4ac',
      preview_name: 'fix/some-branch',
      preview_slug: 'fix-some-branch',
      preview_urls: [
        'https://fix-some-branch-inertialrefd.example.workers.dev',
      ],
      deployment_id: '6f4756b8-cc38-4764-a1e0-c4f9efd3103d',
      deployment_urls: ['https://6f4756b8-inertialrefd.example.workers.dev'],
      timestamp: '2026-09-30T03:48:00.979Z',
    })
  })

  it('reads through the color cf puts on keys even into a pipe', () => {
    const colored = printed((key) => `\x1b[36m${key}\x1b[39m`)
    expect(previewRecord(colored, 'inertialrefd', NOW)).toEqual(
      previewRecord(printed(), 'inertialrefd', NOW),
    )
  })

  it('is nothing when the output holds no preview record', () => {
    expect(previewRecord('◆  Build complete\n', 'inertialrefd', NOW)).toBeNull()
    expect(
      previewRecord('{\n  "type": "deploy"\n}\n', 'inertialrefd', NOW),
    ).toBeNull()
    expect(previewRecord('{\n  "type": \n}\n', 'inertialrefd', NOW)).toBeNull()
  })
})

describe('where the record is written', () => {
  it('prefers the named file', () => {
    const env = {
      WRANGLER_OUTPUT_FILE_PATH: '/out/record.json',
      WRANGLER_OUTPUT_FILE_DIRECTORY: '/out',
    }
    expect(outputFile(env, NOW)).toBe('/out/record.json')
  })

  it('names a fresh file in the directory the way Wrangler does', () => {
    const file = outputFile({ WRANGLER_OUTPUT_FILE_DIRECTORY: '/out' }, NOW)
    expect(file).toMatch(
      /^\/out\/wrangler-output-2026-09-30_03-48-00_979-[0-9a-f]{6}\.json$/,
    )
  })

  it('is nowhere outside a build', () => {
    expect(outputFile({}, NOW)).toBeNull()
  })
})
