#!/usr/bin/env node
/*
 * The terrain archive, from outside the process that fills it.
 *
 *     node scripts/terrainArchive.mjs            {"version":"1-5-3","entries":1246,"bytes":88486528}
 *     node scripts/terrainArchive.mjs version    1-5-3
 *     node scripts/terrainArchive.mjs entries    1246
 *
 * Two readers, and neither can import the store. CI keys its cache of
 * `.data/heightfields/` on `version`, so a bump to the terrain algorithm, the
 * heightfield task or `HEIGHTFIELD_CACHE_REVISION` starts a fresh archive
 * rather than restoring one no request can match; and it saves the archive
 * back only when `entries` grew, so a warm run that generated nothing does not
 * upload the same 90 MB it downloaded. Both are decided in a shell step, which
 * is why this prints one value at a time.
 *
 * The count comes from the store's own tally rather than from the file's size
 * or digest: a warm run touches every row it reads to update its recency, so
 * the file changes on every run and its digest says nothing about whether a
 * tile was added. The colons in the version become dashes because a cache key
 * is a path segment on the runner and a query field on the way to the API.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HEIGHTFIELD_CACHE_VERSION } from '../packages/workers/src/heightfieldCache.ts'
import { DEFAULT_HEIGHTFIELD_DIRECTORY } from '../apps/headless/src/heightfieldStore.ts'

const version = HEIGHTFIELD_CACHE_VERSION.replaceAll(':', '-')

function tally() {
  // The store's own spelling of its file, so the two cannot name different ones.
  const file = join(DEFAULT_HEIGHTFIELD_DIRECTORY, 'tiles.sqlite')
  if (!existsSync(file)) return { entries: 0, bytes: 0 }
  let db = null
  try {
    // Opening is inside the guard as well: a file SQLite refuses to open is
    // no more an archive than one with the wrong schema, and a CI step that
    // throws here fails the job before the check has run.
    db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare('SELECT entries, bytes FROM tally WHERE id=1').get()
    return row === undefined
      ? { entries: 0, bytes: 0 }
      : { entries: Number(row.entries), bytes: Number(row.bytes) }
  } catch {
    // A file that is not the store's schema is not an archive: nothing to save.
    return { entries: 0, bytes: 0 }
  } finally {
    db?.close()
  }
}

const field = process.argv[2]
if (field === 'version') console.log(version)
else if (field === 'entries') console.log(String(tally().entries))
else console.log(JSON.stringify({ version, ...tally() }))
