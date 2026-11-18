import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * Where the slab generator's stages are kept between its processes: JSON
 * for what is rows, and the bytes of a Float64Array for what is a table.
 * Nothing written here names the machine or the time, so two runs of a
 * stage are the same file.
 */

/**
 * The stages' directory. `IR_SLAB_DATA` names another, so two whole runs can
 * stand side by side and be compared.
 */
export const STAGES =
  process.env.IR_SLAB_DATA ??
  fileURLToPath(new URL('../../../../.data/weather/slab/', import.meta.url))

/** Where the generated files go. */
export const RENDERING = fileURLToPath(
  new URL('../../../../packages/rendering/src/', import.meta.url),
)

export function saveStage(name: string, value: unknown): void {
  mkdirSync(STAGES, { recursive: true })
  writeFileSync(`${STAGES}${name}.json`, JSON.stringify(value))
  console.log(`slabTables: wrote ${STAGES}${name}.json`)
}

export function loadStage<Value>(name: string): Value {
  return JSON.parse(readFileSync(`${STAGES}${name}.json`, 'utf8')) as Value
}

/** A table as its bytes: little-endian float64, as the array holds them. */
export function saveTable(name: string, table: Float64Array): void {
  mkdirSync(STAGES, { recursive: true })
  writeFileSync(
    `${STAGES}${name}.f64`,
    new Uint8Array(table.buffer, table.byteOffset, table.byteLength),
  )
}

export function loadTable(name: string): Float64Array {
  const bytes = readFileSync(`${STAGES}${name}.f64`)
  return new Float64Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
}
