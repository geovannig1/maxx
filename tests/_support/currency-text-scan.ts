import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listSourceFiles } from './source-scan'

// Scanners for tests/currency-text-boundary.test.ts, shared with the debt-list generator.
export const SCOPE = ['src/lib', 'src/mcp']
// No file is exempt (the hand-over list was emptied after its merge); kept for planted-control symmetry.
export const MONEY_HANDOVER = new Set<string>()
const DOLLAR_FORMAT = /\$\$\{|['"`]\$['"`]\s*\+|\+\s*['"`]\$['"`]/
// Explicit allowlist: outcome words that are identifiers, not wording, and so are never counted.
//  - Meta standard/custom event names: Meta's own identifiers, sent and read verbatim.
const META_EVENT_NAMES = /\b(AppointmentConfirmed|Schedule|CompleteRegistration)\b/g
//  - Module specifiers (`from '@/lib/ga4/booking-reconciliation'`, `import('...')`): file names are
//    internal identifiers, not text anyone reads.
const MODULE_SPECIFIER_BEFORE = /(?:\bfrom\s*|\bimport\s*\(?\s*)$/
//  - Database contracts: a literal passed to a query-builder call names columns, filters or RPCs
//    (`.select('spend, leads, bookings')`, `.eq('outcome_type', 'booking')`), so it must match the schema.
const DATABASE_CONTRACT_BEFORE = /\.(?:select|order|eq|neq|in|is|rpc|from|filter|or|not|contains|like|ilike)\(\s*(?:'[^']*',\s*)?$/
const OUTCOME_WORD = /\b(bookings?|booked|appointments?)\b/gi
const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g

function files(base: string, roots: readonly string[] = SCOPE): string[] {
  return roots.flatMap((root) => {
    try { return listSourceFiles(path.join(base, root)) } catch { return [] }
  }).map((f) => path.relative(base, f).split(path.sep).join('/'))
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)

export function dollarFormatting(base: string, roots: readonly string[] = SCOPE): string[] {
  return files(base, roots).filter((f) => !MONEY_HANDOVER.has(f)).flatMap((file) =>
    readFileSync(path.join(base, file), 'utf8').split('\n').flatMap((line, i) =>
      !isComment(line) && DOLLAR_FORMAT.test(line) ? [`${file}:${i + 1}`] : []))
}

/** Outcome words inside string literals, per file (whole-identifier literals such as metric keys excluded). */
export function outcomeWordCounts(base: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of files(base)) {
    const text = readFileSync(path.join(base, file), 'utf8').split('\n').filter((l) => !isComment(l)).join('\n')
    let n = 0
    for (const match of text.matchAll(STRING)) {
      const literal = match[0]
      const before = text.slice(Math.max(0, match.index - 200), match.index)
      if (MODULE_SPECIFIER_BEFORE.test(before) || DATABASE_CONTRACT_BEFORE.test(before)) continue
      const body = literal.slice(1, -1)
      if (/^[A-Za-z_.:-]*$/.test(body)) continue
      n += (body.replace(META_EVENT_NAMES, '').match(OUTCOME_WORD) ?? []).length
    }
    if (n > 0) counts[file] = n
  }
  return counts
}

