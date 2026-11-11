import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
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

// Rule 3: a literal "$" used as a currency sign in any text src renders or hands to a model, read through
// the TypeScript parser so comments never count. It catches "$" before a digit ("$0 spend", "<$100"), JSX
// text or a template part ending in "$" right before an interpolated amount (`${x.toFixed(0)}` in JSX,
// `$${n}`), and a lone '$' passed as a display prefix (call argument, parameter default, conditional
// branch), and the word "dollar(s)" in that text ("contribution dollars", "the next dollar"). Explicit allowlist: text marked as a USD example or benchmark, the vertical-benchmark titles
// (approval keys stored in the database, formatted as USD), and a `.replace()` replacement ('$1:$2').
export const CURRENCY_SIGN_SCOPE = ['src']
const USD_MARKED = /USD (?:example|benchmark)|^Vertical benchmark: Meta /
const SIGN_BEFORE_DIGIT = /\$\d/
// "dollars?" followed by a regex quantifier is a matcher pattern, not wording.
const DOLLAR_WORD = /\bdollars?\b(?!\?)/i
const currencyText = (text: string) => (SIGN_BEFORE_DIGIT.test(text) || DOLLAR_WORD.test(text)) && !USD_MARKED.test(text)

function isReplacement(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) return false
  // A [pattern, replacement] pair, as a redaction table holds them.
  if (ts.isArrayLiteralExpression(parent)) return parent.elements.some(ts.isRegularExpressionLiteral)
  return ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
    && /^replace(?:All)?$/.test(parent.expression.name.text) && parent.arguments[1] === node
}

function isLonePrefix(node: ts.StringLiteral): boolean {
  const parent = node.parent
  if (node.text !== '$' || !parent) return false
  if (ts.isCallExpression(parent) && parent.arguments.includes(node)) return true
  if (ts.isParameter(parent) && parent.initializer === node) return true
  return ts.isConditionalExpression(parent) && (parent.whenTrue === node || parent.whenFalse === node)
}

function currencySignsInFile(file: string, rel: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: string[] = []
  const hit = (node: ts.Node) => hits.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (currencyText(node.text) || /\$\s*$/.test(node.text)) hit(node)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if ((currencyText(node.text) && !isReplacement(node))
        || (ts.isStringLiteral(node) && isLonePrefix(node))) hit(node)
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
      if (currencyText(parts.join('${…}'))
        || parts.slice(0, -1).some((part) => part.endsWith('$'))) hit(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

/** Every place under `roots` that prints a literal "$" as a currency sign (rule 3). */
export function literalCurrencySigns(base: string, roots: readonly string[] = CURRENCY_SIGN_SCOPE): string[] {
  return files(base, roots).flatMap((rel) => currencySignsInFile(path.join(base, rel), rel))
}

