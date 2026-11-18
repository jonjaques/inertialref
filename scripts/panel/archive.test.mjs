import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveRound } from './archive.mjs'
import { sha256 } from './packet.mjs'

async function roundDir(round = 'r1', entries = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-archive-in-'))
  await mkdir(path.join(dir, 'keys'))
  await mkdir(path.join(dir, 'packets', 'abc'), { recursive: true })
  const record = {
    round,
    kind: 'judged',
    seed: `seed-${round}`,
    records: [{ file: '/r.json', sha256: 'f00', as: 'record' }],
  }
  await writeFile(path.join(dir, 'round.json'), JSON.stringify(record))
  await writeFile(path.join(dir, 'keys', 'seat-1.json'), '{"packet":"abc"}')
  await writeFile(path.join(dir, 'packets', 'abc', 'review.json'), '{}')
  if (entries) await writeFile(path.join(dir, 'entries.json'), '{}')
  return dir
}

describe('archive.mjs', () => {
  it('copies the round whole, hashes every file, and indexes it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'panel-archive-'))
    const { target, archive } = await archiveRound(await roundDir(), root)
    expect(Object.keys(archive.files)).toEqual([
      'entries.json',
      'keys/seat-1.json',
      'packets/abc/review.json',
      'round.json',
    ])
    expect(archive.files['packets/abc/review.json']).toBe(sha256('{}'))
    const index = JSON.parse(
      await readFile(path.join(root, 'index.json'), 'utf8'),
    )
    const body = await readFile(path.join(target, 'archive.json'))
    expect(index.rounds).toEqual([
      {
        round: 'r1',
        kind: 'judged',
        seed: 'seed-r1',
        dir: 'r1',
        archive: sha256(body),
        records: [{ file: '/r.json', sha256: 'f00' }],
      },
    ])
  })

  it('archives a round once, and refuses one without its entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'panel-archive-'))
    await archiveRound(await roundDir(), root)
    await expect(archiveRound(await roundDir(), root)).rejects.toThrow(
      /archived once/,
    )
    await expect(
      archiveRound(await roundDir('r2', false), root),
    ).rejects.toThrow(/no entries.json/)
  })
})
