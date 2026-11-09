import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// POPULATION guard for error-text redaction. The sampled test (api-error-redaction.test.ts) drives 11
// routes; this scans EVERY src/app/api/**/route.ts and src/mcp/tools/*.ts, plus library modules whose
// return value IS a response body (RESPONSE_MODULES), and fails when a response
// body or tool result could be built from a caught error's or Supabase error's text: `.message`,
// `.details`, `.hint`, `statusDetails`, `String(err|error|e)` or `${err...}`.
//
// Allowed: logging (`console.*`), the redaction helpers themselves (`apiErrorResponse`, `logToolError`),
// a `throw` (the catch site that reads the text is what gets checked), and string classification
// (`=== 'literal'`, `.includes(...)`, `.startsWith(...)`, `regex.test(...)`) that never copies the text.
// Anything else needs an ALLOWLIST entry below with the reason.

const ROOT = process.cwd()
const ERROR_NAME = /^(e|err|error|[A-Za-z0-9]*Error|[A-Za-z0-9]*Err)$/
const DETAIL_PROPERTIES = new Set(['message', 'details', 'hint', 'statusDetails'])
const REDACTION_HELPERS = new Set(['apiErrorResponse', 'logToolError'])
const CLASSIFY_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'test'])

type Hit = { file: string; line: number; text: string }

/** Explicit, reviewed exceptions. `line` must match the flagged line (trimmed). */
const ALLOWLIST: Array<{ file: string; line: RegExp; reason: string }> = [
  {
    // PreparedRequestError is constructed only with literal messages in lib/reporting/prepared-request.ts.
    file: 'src/app/api/reporting/route.ts',
    line: /^if \(error instanceof PreparedRequestError\) return failure\(error\.message, error\.status\)$/,
    reason: 'typed request error with authored literal messages',
  },
  {
    // The dispatcher returns a message only for UnknownToolError (names the requested tool) and
    // ToolInputError (authored argument errors); everything else goes through logToolError.
    file: 'src/mcp/tools/index.ts',
    line: /^\? error\.message$/,
    reason: 'typed, authored tool errors only',
  },
  {
    // Missing-column classification: the message is regex-tested, never copied into the result.
    file: 'src/mcp/tools/creative-fatigue.ts',
    line: /^const message = error\.message \?\? ''$/,
    reason: 'classification only',
  },
  {
    file: 'src/mcp/tools/creative-insights.ts',
    line: /^const message = error\.message \?\? ''$/,
    reason: 'classification only (same helper as creative-fatigue)',
  },
  {
    // ADR-059: RPC exception names are matched to a stable status code; the text is never copied out.
    file: 'src/lib/writes/owner-changes.ts',
    line: /^const text = error\.message \?\? ''$/,
    reason: 'classification only',
  },
  {
    file: 'src/lib/writes/change-review.ts',
    line: /^const text = error\.message \?\? ''$/,
    reason: 'classification only (expired vs other review refusals); logged server-side',
  },
  {
    // Audit-incomplete detail: built for emitAlert/Sentry (server-side) only. The executor's result
    // carries finalize_error: 'AUDIT_FINALIZE_FAILED', never this text.
    file: 'src/lib/writes/executor.ts',
    line: /^(const detail = \[logFinalizeErr && |if \(repairErr\) return auditIncomplete\(changeRequestId, `repair update failed: \$\{repairErr\.message\}`\))/,
    reason: 'alert and Sentry detail only; the response carries a stable code',
  },
  {
    // The precondition-refusal audit moved out of executor.ts (no behavior change): same rule.
    file: 'src/lib/writes/execution-audit.ts',
    line: /^(logError && `action_log \$\{input\.claimId\}: \$\{logError\.message\}`,|requestError && `change_request \$\{input\.changeRequestId\}: \$\{requestError\.message\}`,)/,
    reason: 'alert and Sentry detail only; the response carries a stable code',
  },
]

/** Library modules whose results routes return as the HTTP body unchanged. The executor's result is the
 *  body of POST /api/changes/[id] (it returned raw database text). */
const RESPONSE_MODULES = [
  'src/lib/writes/executor.ts',
  // Split out of executor.ts (proposal, preconditions, audit outcomes) and the stuck-run recovery: their
  // results are response bodies too.
  'src/lib/writes/propose-change.ts',
  'src/lib/writes/write-preconditions.ts',
  'src/lib/writes/execution-audit.ts',
  'src/lib/writes/stuck-change-recovery.ts',
  // ADR-059: owner proposals, reviews and the demo simulator return their results as HTTP bodies too.
  'src/lib/writes/owner-changes.ts',
  'src/lib/writes/change-review.ts',
  'src/lib/writes/demo-executor.ts',
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function populationFiles(): string[] {
  const routes = walk(path.join(ROOT, 'src/app/api')).filter((file) => file.endsWith(`${path.sep}route.ts`))
  const toolsDir = path.join(ROOT, 'src/mcp/tools')
  const tools = readdirSync(toolsDir)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => path.join(toolsDir, entry))
  return [...routes, ...tools, ...RESPONSE_MODULES.map((file) => path.join(ROOT, file))].map((file) => path.relative(ROOT, file)).sort()
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)
  ) current = current.expression
  return current
}

/** `err`, `fooError`, or `result.error` — a caught error or a Supabase `{ error }` value. */
function isErrorValue(node: ts.Expression): boolean {
  const inner = unwrap(node)
  if (ts.isIdentifier(inner)) return ERROR_NAME.test(inner.text)
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === 'error'
  return false
}

function callName(call: ts.CallExpression): string {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = unwrap(callee.expression)
    return `${ts.isIdentifier(receiver) ? receiver.text : '?'}.${callee.name.text}`
  }
  return ''
}

function isClassification(node: ts.Node): boolean {
  const parent = node.parent
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind
    const other = parent.left === node ? parent.right : parent.left
    const isEquality = kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    return isEquality && (ts.isStringLiteral(other) || ts.isNoSubstitutionTemplateLiteral(other))
  }
  // `x.message.includes('...')`
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && CLASSIFY_METHODS.has(parent.name.text)) {
    return ts.isCallExpression(parent.parent)
  }
  // `/regex/.test(x.message)`
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const callee = parent.expression
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'test'
  }
  return false
}

function isExemptContext(node: ts.Node): boolean {
  if (isClassification(node)) return true
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isThrowStatement(current)) return true
    if (ts.isCallExpression(current)) {
      const name = callName(current)
      if (name.startsWith('console.') || REDACTION_HELPERS.has(name)) return true
    }
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return false
  }
  return false
}

function isFlagged(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && DETAIL_PROPERTIES.has(node.name.text)) {
    return node.name.text === 'statusDetails' || isErrorValue(node.expression)
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String') {
    const [arg] = node.arguments
    return Boolean(arg) && ts.isIdentifier(unwrap(arg)) && isErrorValue(arg)
  }
  if (ts.isTemplateSpan(node)) {
    const expression = unwrap(node.expression)
    return ts.isIdentifier(expression) && isErrorValue(expression)
  }
  return false
}

function scanSource(file: string, source: string): Hit[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lines = source.split('\n')
  const hits: Hit[] = []
  const visit = (node: ts.Node) => {
    if (isFlagged(node) && !isExemptContext(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
      hits.push({ file, line: line + 1, text: lines[line].trim() })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return hits
}

function isAllowlisted(hit: Hit): boolean {
  return ALLOWLIST.some((entry) => entry.file === hit.file && entry.line.test(hit.text))
}

describe('error-text redaction population guard', () => {
  const files = populationFiles()

  it('scans the whole population (every API route and every top-level MCP tool module)', () => {
    expect(files.filter((file) => file.startsWith('src/app/api/')).length).toBeGreaterThanOrEqual(60)
    expect(files.filter((file) => file.startsWith('src/mcp/tools/')).length).toBeGreaterThanOrEqual(40)
    expect(files).toContain('src/app/api/ga4/bookings/route.ts')
    expect(files).toContain('src/mcp/tools/competitor-ads.ts')
    expect(files).toContain('src/app/api/cron/daily-sync/route.ts')
    expect(files).toContain('src/lib/writes/executor.ts')
  })

  it('no route or tool builds a client-visible value from error text', () => {
    const hits = files
      .flatMap((file) => scanSource(file, readFileSync(path.join(ROOT, file), 'utf8')))
      .filter((hit) => !isAllowlisted(hit))
    expect(hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`)).toEqual([])
  })

  it('every allowlist entry still matches a real line (no stale exceptions)', () => {
    for (const entry of ALLOWLIST) {
      const hits = scanSource(entry.file, readFileSync(path.join(ROOT, entry.file), 'utf8'))
      expect(hits.some((hit) => entry.line.test(hit.text)), entry.file).toBe(true)
    }
  })
})

describe('scanner controls', () => {
  it('catches each planted leak shape', () => {
    const planted = `
      export async function GET() {
        const { error } = await db.from('t').select()
        if (error) return Response.json({ error: error.message })
        try { x() } catch (err) { return Response.json({ detail: String(err) }) }
        try { x() } catch (e) { return { reason: \`failed: \${e}\` } }
        const res = await db.from('t').select()
        if (res.error) return Response.json({ hint: res.error.hint, details: res.error.details })
        try { x() } catch (caught) { const g = caught as { statusDetails?: unknown }; return Response.json(g.statusDetails) }
        const { error: sourceError } = await q
        return { unavailable_reason: \`could not be read: \${sourceError.message}\` }
      }
    `
    const hits = scanSource('planted/route.ts', planted)
    expect(hits.map((hit) => hit.text)).toEqual([
      "if (error) return Response.json({ error: error.message })",
      "try { x() } catch (err) { return Response.json({ detail: String(err) }) }",
      "try { x() } catch (e) { return { reason: `failed: ${e}` } }",
      "if (res.error) return Response.json({ hint: res.error.hint, details: res.error.details })",
      "if (res.error) return Response.json({ hint: res.error.hint, details: res.error.details })",
      "try { x() } catch (caught) { const g = caught as { statusDetails?: unknown }; return Response.json(g.statusDetails) }",
      "return { unavailable_reason: `could not be read: ${sourceError.message}` }",
    ])
  })

  it('control: the cron allowlist does not excuse a response built from error text in that file', () => {
    const planted = "try { x() } catch (err) { return Response.json({ error: err instanceof Error ? err.message : String(err) }) }"
    const hits = scanSource('src/app/api/cron/daily-sync/route.ts', planted)
    expect(hits.length).toBe(2)
    expect(hits.filter((hit) => !isAllowlisted(hit))).toHaveLength(2)
  })

  it('control: logging, the helpers, throws, classification and non-error data are not flagged', () => {
    const clean = `
      export async function GET() {
        const { data, error } = await db.from('t').select()
        if (error) return apiErrorResponse('GET /x', 'X_FAILED', error)
        if (error) return { reason: logToolError('tool', 'X_FAILED', error) }
        console.error('[x] failed:', error.message, String(error))
        if (error) throw new Error(\`read failed: \${error.message}\`)
        if (error.message === 'Ad account not found') return null
        if (error.message.includes('does not exist')) return null
        if (/missing/i.test(error.message)) return null
        const alerts = data.map((a) => ({ message: a.message, issues: parsed.issues.map((i) => i.message) }))
        return { source: \`\${entry.source.name}\`, alerts }
      }
    `
    expect(scanSource('clean/route.ts', clean)).toEqual([])
  })
})
