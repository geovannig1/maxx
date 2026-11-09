// Minimal, correct CSV builder for the entity/segment table exports. Values are written RAW
// (numbers unformatted) so the file is analysis-ready in Sheets/Excel; formatting lives in the UI.

// A text cell a spreadsheet would evaluate as a formula (leading = + - @, possibly after spaces or a
// byte-order mark, or a leading tab/CR) is exported as text: apostrophe-prefixed and quoted, as in
// src/lib/reporting/export.ts. Numbers are never prefixed, so -5 stays a number.
const FORMULA_START = /^[\s\uFEFF]*[=+\-@]|^[\t\r]/

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' && FORMULA_START.test(value)) return `"'${value.replace(/"/g, '""')}"`
  const s = String(value)
  // Quote if the cell contains a comma, double-quote, or newline; escape quotes by doubling.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function buildCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>
): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return lines.join('\r\n') // CRLF — most compatible with Excel
}
