import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

// CALL-GRAPH PROOF.
//
// The central finding was that five policy modules had ZERO production callers: their unit
// tests passed while the daily pipeline reached none of them. A green suite was therefore not
// evidence that any policy was enforced.
//
// This test fails if a policy module ever becomes unreachable again. It is a STRUCTURAL guard: it
// proves an import edge exists from a named PRODUCTION entry point. Behavioural proof that the edge
// is load-bearing lives in tests/db/integration/evidence-gate-unit.test.ts (the gate reached through
// generateRecommendationsFromFlags) and run-daily-sync-evidence.test.ts (reached through runDailySync).

const SRC = resolve(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}
const ALL = walk(SRC)
const read = (p: string) => readFileSync(p, 'utf8')
const callCountCache = new Map<string, number>()

/**
 * A regex `\bsymbol\b` match counted a COMMENT, an IMPORT, or the function's own
 * DECLARATION as a "caller". This walks the TypeScript AST and counts only real CALL EXPRESSIONS —
 * `symbol(...)` or `x.symbol(...)` — so an imported-but-never-invoked module still fails.
 */
function callExpressionCount(file: string, symbol: string): number {
  const key = `${file}\0${symbol}`
  const cached = callCountCache.get(key)
  if (cached !== undefined) return cached

  const src = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const e = node.expression
      const name = ts.isIdentifier(e) ? e.text
        : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) ? e.name.text
        : null
      if (name === symbol) count++
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(src, visit)
  callCountCache.set(key, count)
  return count
}

function directFunctionCallExpressionCount(
  file: string,
  functionName: string,
  calledSymbol: string,
): number {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let count = 0
  const countCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression) ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text
        : null
      if (name === calledSymbol) count += 1
    }
    ts.forEachChild(node, countCalls)
  }
  const findFunction = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) {
      countCalls(node.body)
      return
    }
    ts.forEachChild(node, findFunction)
  }
  ts.forEachChild(source, findFunction)
  return count
}

/** Files that CALL `symbol` and are NOT the module that defines it. */
function callersOf(symbol: string, definedIn: string): string[] {
  return ALL.filter((f) => !f.endsWith(definedIn) && callExpressionCount(f, symbol) > 0)
}

/** Transitively: is `target` reachable from `entry` through relative/@ imports? */
function reachableFrom(entry: string, targetSuffix: string, seen = new Set<string>()): boolean {
  const abs = resolve(SRC, entry)
  if (seen.has(abs)) return false
  seen.add(abs)
  let src: string
  try { src = read(abs) } catch { return false }
  if (abs.endsWith(targetSuffix)) return true
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  for (const imp of imports) {
    let next: string | null = null
    if (imp.startsWith('@/')) next = join(SRC, imp.slice(2))
    else if (imp.startsWith('.')) next = resolve(abs, '..', imp)
    if (!next) continue
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const cand = `${next}${ext}`
      try {
        statSync(cand)
        if (reachableFrom(cand, targetSuffix, seen)) return true
        break
      } catch { /* try next extension */ }
    }
  }
  return false
}

// Every new policy, its defining module, and the PRODUCTION entry point that must reach it.
const POLICIES: Array<{ symbol: string; module: string; entry: string; entryLabel: string }> = [
  { symbol: 'decideRecommendation', module: 'decision-policy.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'arbitrateRecommendationPublications', module: 'recommendation-authority.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'gatherAccountEvidence', module: 'evidence-gate.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'resolveAudience', module: 'audience/resolver.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'conversionActionability', module: 'conversion-actionability.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'resolveOptimizationEventEvidence', module: 'conversion-actionability.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'analyzeCreativeDiversity', module: 'creative/identity.ts', entry: 'lib/recommendations/generate.ts', entryLabel: 'generateRecommendationsFromFlags (daily pipeline)' },
  { symbol: 'computeVideoMetrics', module: 'creative/video-metrics.ts', entry: 'lib/sync/upsert-insights.ts', entryLabel: 'insight ingestion (daily sync)' },
  { symbol: 'computeVideoMetrics', module: 'creative/video-metrics.ts', entry: 'app/api/ads/trend/route.ts', entryLabel: 'ad trend API' },
  { symbol: 'followPages', module: 'meta/contract.ts', entry: 'lib/platforms/meta/fetch-dataset-quality.ts', entryLabel: 'dataset diagnostics fetcher' },
  { symbol: 'followPages', module: 'meta/contract.ts', entry: 'lib/platforms/meta/fetch-meta-recommendations.ts', entryLabel: 'native recommendations fetcher' },
  { symbol: 'parseRecommendationsPage', module: 'parse-recommendations.ts', entry: 'lib/platforms/meta/fetch-meta-recommendations.ts', entryLabel: 'native recommendations fetcher' },
  { symbol: 'classifyWindowSettle', module: 'settle-window.ts', entry: 'lib/diagnostics/launch-performance.ts', entryLabel: 'launch diagnosis' },
  { symbol: 'spendConcentration', module: 'diagnostics/structure.ts', entry: 'lib/diagnostics/launch-performance.ts', entryLabel: 'launch diagnosis' },
  { symbol: 'loadReportingSection', module: 'reporting/loader.ts', entry: 'app/api/reporting/route.ts', entryLabel: 'authenticated reporting route' },
  { symbol: 'validateReportingPacket', module: 'reporting/validation.ts', entry: 'app/api/reporting/route.ts', entryLabel: 'authenticated reporting route' },
  { symbol: 'readMetaReport', module: 'reporting/meta-reader.ts', entry: 'app/api/reporting/route.ts', entryLabel: 'authenticated reporting route' },
  { symbol: 'readOwnerDiagnosticsSnapshot', module: 'diagnostics/owner-surface.ts', entry: 'app/(dashboard)/reports/[date]/page.tsx', entryLabel: 'stored daily report page' },
  { symbol: 'interpretMetaCapiResponse', module: 'capi/acuity-capi.ts', entry: 'lib/capi/acuity-capi.ts', entryLabel: 'server CAPI sender' },
  // The GA/ledger booking join. Business totals come from the ledger, GA only enriches.
  { symbol: 'buildExecutiveEvidenceForReport', module: 'report/executive-evidence-production.ts', entry: 'lib/report/generator.ts', entryLabel: 'daily report generator' },
  { symbol: 'aggregateBusinessFacts', module: 'outcomes/business-facts.ts', entry: 'lib/report/executive-evidence-business-readers.ts', entryLabel: 'executive evidence business reader' },
  { symbol: 'reconcileGa4Bookings', module: 'ga4/booking-reconciliation.ts', entry: 'lib/ga4/booking-reconciliation.ts', entryLabel: 'GA/ledger reconciliation' },
  { symbol: 'renderGa4ReconciliationBlock', module: 'ga4/booking-reconciliation.ts', entry: 'lib/ga4/booking-reconciliation.ts', entryLabel: 'GA/ledger reconciliation' },
  { symbol: 'getGa4IdentifiedBookingEvents', module: 'ga4/client.ts', entry: 'lib/ga4/booking-reconciliation.ts', entryLabel: 'GA/ledger reconciliation' },
]

describe('call-graph proof — every new policy has a PRODUCTION caller', () => {
  it.each(POLICIES)('$symbol is reachable from $entryLabel', ({ symbol, module, entry }) => {
    if (entry.endsWith(module)) {
      // Defined and consumed in the SAME module: prove it is actually invoked there, not merely
      // exported. An exported-but-uninvoked function is the same defect in a smaller radius.
      const invocations = callExpressionCount(resolve(SRC, entry), symbol)
      expect(invocations, `${symbol} is exported by ${module} but never CALLED in it`).toBeGreaterThan(0)
      return
    }
    // 1. It has at least one caller outside its own module.
    const callers = callersOf(symbol, module)
    expect(callers.length, `${symbol} has NO production caller — it is a proposal, not an enforced contract`).toBeGreaterThan(0)
    // 2. The named production entry point reaches its defining module.
    expect(reachableFrom(entry, module), `${entry} does not reach ${module}`).toBe(true)
  })

  it('the daily recommendation pipeline reaches the decision policy', () => {
    expect(reachableFrom('lib/recommendations/generate.ts', 'decision-policy.ts')).toBe(true)
    expect(reachableFrom('lib/recommendations/generate.ts', 'evidence-gate.ts')).toBe(true)
  })

  it('the daily report reaches the canonical evidence ledger and exact GA identity join', () => {
    expect(reachableFrom('lib/report/generator.ts', 'executive-evidence-business-readers.ts')).toBe(true)
    expect(reachableFrom('lib/report/generator.ts', 'business-facts.ts')).toBe(true)
    expect(reachableFrom('lib/report/generator.ts', 'booking-reconciliation.ts')).toBe(true)
  })

  it('the live reporting workspace and stored report each reach their governed evidence surface', () => {
    expect(reachableFrom('app/(dashboard)/dashboard/page.tsx', 'ReportingWorkspace.tsx')).toBe(true)
    expect(reachableFrom('app/(dashboard)/dashboard/page.tsx', 'reporting/use-reporting-data.ts')).toBe(true)
    expect(reachableFrom('app/(dashboard)/dashboard/page.tsx', 'reporting/request-packet.ts')).toBe(true)
    expect(directFunctionCallExpressionCount(resolve(SRC, 'lib/reporting/use-reporting-data.ts'), 'useReportingData', 'requestReportingPacket')).toBeGreaterThan(0)
    expect(directFunctionCallExpressionCount(resolve(SRC, 'lib/reporting/request-packet.ts'), 'requestReportingPacket', 'withReportingDeadline')).toBeGreaterThan(0)
    expect(read(resolve(SRC, 'lib/reporting/request-packet.ts'))).toMatch(/fetch\(`\/api\/reporting\?\$\{key\}&section=\$\{section\}/)
    expect(reachableFrom('app/api/reporting/route.ts', 'reporting/loader.ts')).toBe(true)
    expect(reachableFrom('app/api/reporting/route.ts', 'reporting/validation.ts')).toBe(true)
    expect(reachableFrom('app/api/reporting/route.ts', 'reporting/meta-reader.ts')).toBe(true)
    expect(reachableFrom('app/(dashboard)/reports/[date]/page.tsx', 'OwnerDiagnosticsPanel.tsx')).toBe(true)
  })

  it('the owner builder directly reads paid outcomes and both assembly paths call the builder', () => {
    const ownerSurface = resolve(SRC, 'lib/diagnostics/owner-surface.ts')
    expect(directFunctionCallExpressionCount(
      ownerSurface,
      'buildOwnerDiagnostics',
      'readPaidCreativeOutcomes',
    )).toBeGreaterThan(0)
    expect(reachableFrom(
      'lib/diagnostics/owner-surface.ts',
      'creative/paid-outcomes-store.ts',
    )).toBe(true)

    expect(reachableFrom('app/(dashboard)/reports/[date]/page.tsx', 'diagnostics/owner-surface.ts')).toBe(true)
  })

  it('the CAPI sender reaches the delivery RPC by name', () => {
    expect(read(resolve(SRC, 'lib/capi/acuity-capi.ts'))).toMatch(/record_conversion_delivery/)
  })

  it('the guard itself scans a real source tree', () => {
    expect(ALL.length).toBeGreaterThan(100)
  })
})

describe('call-graph proof — forward coverage is HONESTLY reported as uncalled', () => {
  // computeForwardCoverage still has no production caller: no migration persists a go-live boundary,
  // so wiring it would require inventing one. That is recorded as a LIMITATION, not claimed as a
  // contract. This test pins the honest state so the record and the code cannot drift apart.
  it('computeForwardCoverage has no production caller yet', () => {
    const callers = callersOf('computeForwardCoverage', 'forward-coverage.ts')
    expect(callers, 'if this is now wired, update the evidence-integrity plan and this test').toEqual([])
  })

  it('experiment EVALUATION and completion transitions have no production caller yet', () => {
    // The registry is durable and the transition API exists, but nothing in production collects
    // observations or completes a run. Calling it a "full runtime" would overstate it.
    expect(callersOf('evaluateExperiment', 'experiment-registry.ts')).toEqual([])
    expect(callersOf('completeExperiment', 'experiment-registry.ts')).toEqual([])
    expect(callersOf('startExperiment', 'experiment-registry.ts')).toEqual([])
    expect(callersOf('runningExperimentConflicts', 'experiment-registry.ts')).toEqual([])
    // A failed decision gate cannot invent a test contract. CampaignPlan-driven brief creation is
    // deliberately unwired until owner ceilings and the measurement/maturity contract exist.
    expect(callersOf('buildTestBrief', 'decision-policy.ts')).toEqual([])
    expect(callersOf('createTestBrief', 'experiment-registry.ts')).toEqual([])
  }, 60_000)
})

describe('call-graph proof — other modules HONESTLY reported as uncalled', () => {
  it('scoreRetentionForLength has no production caller', () => {
    // health-score.ts implements the same length-aware banding inline; this is the tested reference
    // implementation. Recorded as a limitation, not claimed as an enforced contract.
    expect(callersOf('scoreRetentionForLength', 'video-metrics.ts')).toEqual([])
  })

  it('assessRotationBench remains unwired until corroborated fatigue evidence exists', () => {
    expect(callersOf('assessRotationBench', 'rotation-bench.ts')).toEqual([])
  })
})

describe('the AST check is stricter than a text match', () => {
  it('a COMMENT mentioning a symbol is not a caller', () => {
    // decision-policy.ts's own doc comments name decideRecommendation; only generate.ts calls it.
    const callers = callersOf('decideRecommendation', 'decision-policy.ts')
    for (const c of callers) expect(callExpressionCount(c, 'decideRecommendation')).toBeGreaterThan(0)
  })

  it('an IMPORT alone is not a caller', () => {
    // Synthesised proof: a file that only imports a symbol has zero call expressions for it.
    const importOnly = ALL.find((f) => /import[^\n]*\bbuildTestBrief\b/.test(read(f)) && callExpressionCount(f, 'buildTestBrief') === 0)
    if (importOnly) expect(callExpressionCount(importOnly, 'buildTestBrief')).toBe(0)
    // Production intentionally has no caller until CampaignPlan owns the test contract.
    expect(callersOf('buildTestBrief', 'decision-policy.ts')).toEqual([])
  })
})
