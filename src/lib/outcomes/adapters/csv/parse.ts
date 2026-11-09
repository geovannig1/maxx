/**
 * RFC 4180 CSV reader for the outcome import. Written here rather than imported: the
 * format is small, and the import needs exact behaviour on the edge cases a dependency may treat
 * leniently (text after a closing quote, a quote inside an unquoted field), which are refused.
 *
 * - Fields are separated by commas; records by CRLF, LF or a lone CR.
 * - A field that starts with `"` is quoted: it may contain commas, line breaks and `""` (one quote).
 *   After its closing quote only a comma, a line break or the end of the file may follow.
 * - A UTF-8 byte-order mark before the first header is removed. Blank lines are skipped.
 * - Each record carries the spreadsheet row it starts on (the header is row 1); a quoted line break
 *   does not start a new row, exactly as a spreadsheet shows it.
 */

export interface CsvRecord {
  row: number
  fields: string[]
}

export type CsvParseError = 'empty_file' | 'binary_content' | 'unterminated_quote' | 'invalid_quote' | 'too_many_rows'

export type CsvParseResult =
  | { ok: true; records: CsvRecord[] }
  | { ok: false; error: CsvParseError; row: number | null }

export function parseCsv(input: string, opts: { maxRecords?: number } = {}): CsvParseResult {
  const maxRecords = opts.maxRecords ?? Number.POSITIVE_INFINITY
  if (input.includes('\u0000')) return { ok: false, error: 'binary_content', row: null }
  const text = input.startsWith('﻿') ? input.slice(1) : input

  const records: CsvRecord[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false // the current field started with a quote
  let inQuotes = false // inside a quoted field, before its closing quote
  let afterClose = false // a quoted field has closed; only a separator may follow
  let lineEmpty = true // nothing at all has been read on this record yet
  let row = 1 // spreadsheet row of the current record: blank lines count, quoted line breaks do not

  const endField = () => {
    fields.push(field)
    field = ''
    quoted = false
    afterClose = false
  }
  const endRecord = (): CsvParseResult | null => {
    if (lineEmpty) return null
    endField()
    if (records.length >= maxRecords) return { ok: false, error: 'too_many_rows', row }
    records.push({ row, fields })
    fields = []
    lineEmpty = true
    return null
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch !== '"') {
        field += ch
      } else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else {
        inQuotes = false
        afterClose = true
      }
      continue
    }
    if (ch === ',') {
      lineEmpty = false
      endField()
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      const failed = endRecord()
      if (failed) return failed
      row++
    } else if (afterClose) {
      return { ok: false, error: 'invalid_quote', row }
    } else if (ch === '"') {
      if (field.length > 0 || quoted) return { ok: false, error: 'invalid_quote', row }
      quoted = true
      inQuotes = true
      lineEmpty = false
    } else {
      field += ch
      lineEmpty = false
    }
  }
  if (inQuotes) return { ok: false, error: 'unterminated_quote', row }
  const failed = endRecord()
  if (failed) return failed
  if (records.length === 0) return { ok: false, error: 'empty_file', row: null }
  return { ok: true, records }
}
