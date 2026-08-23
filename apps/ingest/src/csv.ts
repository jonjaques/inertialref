/*
 * A CSV reader, because both sources are CSV and neither is simple enough for
 * `split(',')`.
 *
 * HYG quotes any field that contains a comma — which includes `bf` values like
 * `9Alp CMa` (no comma, but quoted anyway) and proper names like
 * `Barnard's Star`. The NASA archive additionally emits `""` for an embedded
 * quote. Both are ordinary RFC 4180; what is not ordinary is that a naive split
 * does not fail on them, it silently shifts every column after the offending one
 * by a position, so a star's spectral type becomes its color index.
 */

export interface CsvTable {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
  /** Column value by name, `''` when absent. */
  cell(row: readonly string[], column: string): string
}

function splitRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') {
      quoted = true
    } else if (c === ',') {
      record.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      // A bare \r inside an unquoted field does not occur in either source; a
      // \r\n must not produce an empty record between the two characters.
      if (c === '\r' && text[i + 1] === '\n') i += 1
      record.push(field)
      field = ''
      records.push(record)
      record = []
    } else field += c
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

export function parseCsv(text: string): CsvTable {
  const records = splitRecords(text).filter(
    (record) => record.length > 1 || (record[0] ?? '') !== '',
  )
  const header = records.shift() ?? []
  const columns = header.map((name) => name.trim())
  const index = new Map(columns.map((name, i) => [name, i]))
  return {
    columns,
    rows: records,
    cell(row, column) {
      const at = index.get(column)
      return at === undefined ? '' : (row[at] ?? '').trim()
    },
  }
}

/** A numeric cell, or null when it is blank or unparseable. */
export function number(
  table: CsvTable,
  row: readonly string[],
  column: string,
): number | null {
  const text = table.cell(row, column)
  if (text === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}
