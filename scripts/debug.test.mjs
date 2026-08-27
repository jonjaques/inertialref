import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * The four editor debug configurations, and the Node inspect flag they
 * assume is already on. A launch.json that drifted to three configs, or a
 * `pnpm sim` that dropped `--inspect`, would still typecheck and still
 * pass every simulation test — the debugger would be the first thing to
 * notice, from a machine that is not this one.
 */

const ROOT = new URL('../', import.meta.url)

const jsonc = (relative) => {
  const text = readFileSync(new URL(relative, ROOT), 'utf8')
  // Strip block comments only. `//` would eat `http://` inside strings.
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, ''))
}

describe('editor debug configurations', () => {
  it('exposes launch and attach for Node and the browser', () => {
    const { configurations } = jsonc('.vscode/launch.json')
    const names = configurations.map((one) => `${one.request} ${one.type}`)
    expect(names).toEqual([
      'launch chrome',
      'attach chrome',
      'launch node',
      'attach node',
    ])
  })

  it('starts the game servers as a background task before launching Chrome', () => {
    const { configurations } = jsonc('.vscode/launch.json')
    const browser = configurations.find(
      (one) => one.request === 'launch' && one.type === 'chrome',
    )
    expect(browser.preLaunchTask).toBe('dev')
    expect(browser.url).toMatch(/5173/)

    const { tasks } = jsonc('.vscode/tasks.json')
    const dev = tasks.find((one) => one.label === 'dev')
    expect(dev.isBackground).toBe(true)
    expect(dev.command).toMatch(/dev\.mjs/)
  })

  it('attaches Node to the inspect port the headless runner opens', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))
    expect(pkg.scripts.sim).toContain('--inspect=127.0.0.1:9229')

    const { configurations } = jsonc('.vscode/launch.json')
    const attach = configurations.find(
      (one) => one.request === 'attach' && one.type === 'node',
    )
    expect(attach.port).toBe(9229)
  })

  it('keeps the Worker inspector off Node’s default port and uploads its maps', () => {
    const wrangler = readFileSync(
      new URL('apps/server/wrangler.jsonc', ROOT),
      'utf8',
    )
    expect(wrangler).toMatch(/"upload_source_maps":\s*true/)
    expect(wrangler).toMatch(/"inspector_port":\s*9230/)
  })
})
