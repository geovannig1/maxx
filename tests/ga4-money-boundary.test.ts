import './_support/outcome-noun-booking'
import { withBookingNouns } from './_support/booking-noun-source'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// SOURCE-LEVEL BOUNDARY. Comments and field names are conventions; this is enforcement.
//
// A review's core finding was that renaming the GA readers is only half a fix — the other half
// is preventing a money surface from reaching raw GA aggregates again. These pins fail the build if
// anyone reintroduces the pattern, including me.

const SRC = resolve(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const ALL = walk(SRC)
const read = (p: string) => readFileSync(p, 'utf8')
const rel = (p: string) => p.slice(SRC.length + 1)

/** Modules whose output is money: a count of bookings, a value, a CPA, a ROAS or a MER. */
const MONEY_SURFACES = [
  'mcp/tools/economics.ts',
  'lib/analytics/campaign-roas.ts',
  'lib/recommendations/evidence-gate.ts',
  'lib/report/generator.ts',
  'lib/report/weekly.ts',
  'app/report/client/page.tsx',
]

/** The raw GA aggregation APIs. They return telemetry with no appointment identity. */
const RAW_GA_READERS = [
  'getGa4ConfirmationTelemetryBySource',
  'getGa4ConfirmationTelemetryByCampaign',
  'getGa4Bookings',
]

/** Modules allowed to call a raw reader: the join itself, and attribution/diagnostic surfaces that
 *  present telemetry AS telemetry. Every entry here is a deliberate decision, not a default. */
const TELEMETRY_CONSUMERS_ALLOWED = new Set([
  'lib/ga4/client.ts',
  'lib/ga4/booking-reconciliation.ts',
  'lib/analytics/campaign-roas.ts',       // reads telemetry for CONTEXT; every roas field is exact-gated
  'lib/report/generator.ts',              // renders it in a block labelled telemetry, derives no ROAS
  'lib/report/weekly.ts',
  'lib/recommendations/evidence-gate.ts', // plane-conflict context that can only DEMOTE confidence
  'app/report/client/page.tsx',
  'lib/monitoring/run.ts',
  'lib/diagnostics/reconciliation-report.ts',
  'lib/diagnostics/launch-performance.ts',
  'lib/modes/launch-readiness.ts',
  'lib/tracking/utm-validator.ts',
  'lib/learning/outcomes.ts',
  'lib/learning/ledger-outcomes.ts',
  'lib/report/task-revalidation.ts',
  'components/dashboard/dashboard-data.ts',
  'app/api/ga4/bookings/route.ts',
  'mcp/tools/operating-mode.ts',
  'mcp/tools/utm-health.ts',
  'mcp/tools/ga4-campaigns.ts',
])

function callsIn(file: string): Set<string> {
  const src = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const names = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression
      if (ts.isIdentifier(e)) names.add(e.text)
      else if (ts.isPropertyAccessExpression(e)) names.add(e.name.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return names
}

describe('money surfaces cannot reach raw GA aggregation', () => {
  it('the economics tool never calls a raw GA reader', () => {
    // It is the clearest case: its whole output is CPA and a profit view. It must consume only the
    // exact ledger-linked join.
    const calls = callsIn(join(SRC, 'mcp/tools/economics.ts'))
    for (const r of RAW_GA_READERS) {
      expect(calls.has(r), `economics.ts calls ${r} — its output is money and must use exact evidence`).toBe(false)
    }
    expect(calls.has('buildGa4ReconciliationBlock')).toBe(true)
    expect(calls.has('exactPaidEvidence')).toBe(true)
  })

  it('no module outside the reviewed allowlist calls a raw GA reader', () => {
    const offenders: string[] = []
    for (const f of ALL) {
      const r = rel(f)
      if (TELEMETRY_CONSUMERS_ALLOWED.has(r)) continue
      const calls = callsIn(f)
      for (const reader of RAW_GA_READERS) if (calls.has(reader)) offenders.push(`${r} -> ${reader}`)
    }
    expect(offenders, 'a NEW consumer of raw GA telemetry appeared. Classify it: business truth (use the Acuity ledger), exact attribution (use the appointment-id join), or telemetry (label it and add it here).').toEqual([])
  })

  it('the raw GA readers never expose an unqualified `bookings` or `revenue` field', () => {
    const src = read(join(SRC, 'lib/ga4/client.ts'))
    // The telemetry types must name their quantities. `bookings:`/`revenue:` as a returned field is
    // exactly what let money surfaces consume GA aggregates by accident.
    const declaredTelemetry = src.slice(src.indexOf('export interface Ga4ConfirmationTelemetryBucket'))
    expect(declaredTelemetry).toMatch(/confirmationEvents: number/)
    expect(declaredTelemetry).toMatch(/eventValue: number/)
    const bucketBody = src.slice(src.indexOf('export interface Ga4ConfirmationTelemetryBucket'))
      .slice(0, src.slice(src.indexOf('export interface Ga4ConfirmationTelemetryBucket')).indexOf('}'))
    expect(/^\s*bookings:/m.test(bucketBody)).toBe(false)
    expect(/^\s*revenue:/m.test(bucketBody)).toBe(false)
  })

  it('the dead per-appointment-type GA reader is gone, not left as a footgun', () => {
    const src = read(join(SRC, 'lib/ga4/client.ts'))
    expect(src).not.toMatch(/export async function getGa4BookingsByAppointmentType/)
    expect(src).toMatch(/REMOVED: getGa4BookingsByAppointmentType/)
  })

  it('every money surface reaches the ledger or the exact join', () => {
    // NOTE ON WHAT THIS PROVES. A review was right that presence of a symbol is not provenance of a
    // rendered value. This check is now only the CHEAP HALF: it catches a money surface that reaches
    // NEITHER source at all. The real proof that each rendered number derives from the right source is
    // behavioural and lives in tests/money-surface-contracts.test.ts, which mocks the boundary and
    // asserts the OUTPUT (economics CPA null-with-reason, campaign ROAS null against GA's 9 events /
    // $2700, the assembled prompt's language). Neither test alone is sufficient.
    const failures: string[] = []
    for (const m of MONEY_SURFACES) {
      const src = read(join(SRC, m))
      const usesExact = /buildGa4ReconciliationBlock|exactPaidEvidence|getBusinessFacts|aggregateBusinessFacts|getBusinessFactsForWindow|buildExecutiveEvidenceForReport|readExecutiveEvidenceGeneration/.test(src)
      if (!usesExact) failures.push(m)
    }
    expect(failures, 'these surfaces emit money without reaching the ledger or the exact join').toEqual([])
  })

  it('no surface derives a ROAS, CPA or MER by dividing GA event value or event counts', () => {
    // BEHAVIOUR-ADJACENT, not allowlist-based: this scans EVERY production file for the arithmetic
    // itself, so a new consumer cannot reintroduce it by being added to an allowlist.
    const offenders: string[] = []
    for (const f of ALL) {
      const src = read(f)
      for (const line of src.split('\n')) {
        const code = line.split('//')[0]
        // GA telemetry fields divided by spend, or used as a CPA denominator.
        if (/\b(eventValue|confirmationEvents|adRevenue|adBookings)\b[^\n]*\/[^\n]*\b(spend|Spend)\b/.test(code)
          || /\b(spend|Spend)\w*\s*\/\s*[^\n]*\b(confirmationEvents|adBookings)\b/.test(code)) {
          offenders.push(`${rel(f)}: ${code.trim().slice(0, 110)}`)
        }
      }
    }
    expect(offenders, 'GA telemetry divided by spend is a money claim built on telemetry — use the exact join, or report unavailable').toEqual([])
  })

  it('paid authority is driven only by the immutable interaction-cohort pair', () => {
    // An earlier revision replaced GA events with the Acuity BUSINESS total — which includes
    // organic, phone and manual bookings. On an organic-heavy account that could lift Maxx into a mode
    // authorising budget changes without a single verified paid outcome. The three populations are now
    // separate fields, and only the exact one may unlock money authority.
    const mode = read(join(SRC, 'lib/modes/operating-mode.ts'))
    expect(mode).toMatch(/exactPaidBookings30d/)
    // Budget authority is split by action. The operating mode delegates economics to the shared
    // directional policy instead of recreating CPA arithmetic beside it.
    expect(mode).toMatch(/const canRecommendBudgetScale =/)
    expect(mode).toMatch(/analyzePaidCohortDirection\(/)
    expect(mode).toMatch(/evaluateDirection\('budget_scale'/)
    expect(mode).toMatch(/evaluateDirection\('budget_cut'/)
    expect(mode).toMatch(/const pragmaticScaleAllowed = !!s\.mediaBuyerRecommendationsEnabled/)
    expect(mode).toMatch(/const pragmaticCutAllowed = !!s\.mediaBuyerRecommendationsEnabled/)
    expect(mode).toMatch(/const canRecommendBudgetScale = pragmaticScaleAllowed/)
    expect(mode).toMatch(/const canRecommendBudgetCut = pragmaticCutAllowed/)
    const directional = read(join(SRC, 'lib/authority/directional-policy.ts'))
    expect(directional).toMatch(/recent\.contributionInterval\.lower <= 0/)
    expect(directional).toMatch(/lagged\.contributionInterval\.upper >= 0/)
    expect(directional).toMatch(/incrementality === 'attributed_only'/)
    // Booking CPA and legacy target defaults cannot re-enter money authority.
    const modeCode = mode.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    expect(modeCode).not.toMatch(/REC_THRESHOLDS\.(TARGET_CPA|MAX_CPA)/)
    const directionalCode = directional.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    expect(directionalCode).not.toMatch(/exactCpa\s*[<>]=?\s*(ev\.)?(targetCpa|maxCpa)/)
    // Per-campaign authority comes from the committed generation's complete unit set, never GA labels
    // or a campaign-row sum standing in for the exact cohort denominator.
    expect(mode).toMatch(/recentScale\.allUnitsComplete === true/)
    // businessBookings30d must never reach the authority predicates.
    const authorityBlock = mode.slice(mode.indexOf('const canMakePerformanceClaims'), mode.indexOf('const restrictions'))
    expect(authorityBlock).not.toMatch(/businessBookings30d/)

    for (const f of ['mcp/tools/operating-mode.ts', 'components/dashboard/dashboard-data.ts']) {
      const src = read(join(SRC, f))
      const line = src.split('\n').find((l) => /exactPaidBookings30d\s*:/.test(l.split('//')[0])) ?? ''
      expect(line, `${f} must supply exactPaidBookings30d explicitly`).not.toBe('')
      expect(line, `${f} passes a GA-derived value as the proven paid signal`).not.toMatch(/confirmationEvents|adBookings|ga4Paid/i)
    }
    const cockpit = read(join(SRC, 'lib/cockpit/builder.ts'))
    expect(cockpit).not.toMatch(/ga4|confirmationEvents|adBookings/i)
    // The Meta-only cockpit no longer exposes tracked checkout return. Its sole ROAS is
    // derived from canonical Meta purchase value and identical-window Meta spend.
    expect(cockpit).not.toMatch(/trackedRoasAvailable|trackedCheckoutRoas/i)
    expect(cockpit).toMatch(/purchaseRoasAvailable[\s\S]{0,500}purchaseValueClaim/)
    expect(read(join(SRC, 'lib/report/weekly.ts'))).not.toMatch(/detectOperatingMode\(/)
  })

  it('every ledger reader SELECTS the origin column the exactness rule depends on', () => {
    // Found the hard way: web_origin_state was added to the view and to the predicate, but not to the
    // SELECT lists. Every row then defaulted to origin_unknown, which silently blocked exactness
    // everywhere — a failure no existing test could see, because the column simply was not requested.
    // the business-facts and metrics reads moved to the scoped generic reader (lib/outcomes/reader.ts).
    for (const f of ['lib/outcomes/reader.ts', 'lib/ga4/booking-reconciliation.ts']) {
      const src = read(join(SRC, f))
      const selects = src.split('\n').filter((l) => /\.select\(/.test(l) && /business_state/.test(l))
      expect(selects.length, `${f} should read the canonical view`).toBeGreaterThan(0)
      for (const sel of selects) {
        expect(sel, `${f} selects business_state without web_origin_state`).toMatch(/web_origin_state/)
      }
    }
  })

  it('exactly one classifier defines the business states', () => {
    // Two implementations of one rule drift. The SQL view and this module are pinned to each other by
    // the integration test; nothing else may define the states. Since ADR-058 the one classifier is the
    // generic outcome model; the appointment vocabulary in lib/outcomes/adapters/acuity/business-facts.ts delegates to it.
    const OWNER = 'lib/outcomes/model.ts'
    const defines = (f: string) => /'active_value_bearing'\s*:/.test(read(f)) || /'active_zero_value'\s*$/m.test(read(f))
      || /return 'active_zero_value'/.test(read(f)) || /\? 'active_value_bearing' : 'active_zero_value'/.test(read(f))
    // Control: the instrument recognises the owner's own definition.
    expect(ALL.filter((f) => rel(f) === OWNER).filter(defines).map(rel)).toEqual([OWNER])
    const offenders = ALL.filter((f) => rel(f) !== OWNER).filter(defines).map(rel)
    expect(offenders, `business-state classification must live only in ${OWNER}`).toEqual([])
  })
})

// The strings below are INSTRUCTIONS to the model and COPY the owner reads. The AST checks above see
// arithmetic and call sites; they cannot see a system prompt telling Maxx that GA aggregates are
// actual paid bookings. Those strings survived two passes of renaming the code beneath
// them, so they are pinned here as behaviour.
describe('the live brain never calls GA telemetry bookings, revenue or actuals', () => {
  const SURFACES: Array<[string, string]> = [
    ['MCP system instructions', 'mcp/instructions.ts'],
    ['MCP tool registrations', 'mcp/tools/index.ts'],
    ['ga4-campaigns tool payload', 'mcp/tools/ga4-campaigns.ts'],
    ['daily report prompt', 'lib/report/prompt-builder.ts'],
    ['weekly report prompt', 'lib/report/weekly.ts'],
    ['playbooks', 'lib/playbooks/playbooks.ts'],
    ['campaign ROAS panel', 'components/dashboard/CampaignRoasPanel.tsx'],
    ['reconciliation diagnostics', 'components/diagnostics/ReconciliationSection.tsx'],
  ]

  // Phrases that assert GA is money or should drive an ad-performance judgement.
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/GA4? (is|remains) the (source of truth|booking|revenue)/i, 'calls GA the source of truth'],
    [/use GA4? for (booking|money|revenue)/i, 'tells a reader to use GA for money'],
    [/GA4? (bookings|revenue)\b/i, 'calls GA events bookings or revenue'],
    [/ad-attributed\s*=\s*GA4? PAID/i, 'equates ad-attributed outcomes with GA paid telemetry'],
    [/GA4?\s*\((booking|revenue)[^)]*source of truth/i, 'calls GA the booking/revenue source of truth'],
    [/GA4? shows \d+ bookings/i, 'reports GA event counts as bookings'],
    [/[Rr]evenue per booking/, 'derives revenue-per-booking from GA telemetry'],
    [/GA4?[- ]actual/i, 'calls GA "actual"'],
    [/GA4? ACTUAL/, 'calls GA "ACTUAL"'],
    [/GA4? paid[^.\n]{0,40}(source of truth|money truth|the truth)/i, 'calls GA paid the source of truth'],
    [/(use|judge)[^.\n]{0,30}GA4? PAID[^.\n]{0,30}(judge|performance)/i, 'tells the model to judge ad performance on GA paid'],
    [/Money truth[^\n]{0,30}GA/i, 'labels GA output "money truth"'],
    [/reliabl\w*[^.\n]{0,40}from the ads/i, 'claims GA channel classification proves an outcome came from ads'],
    [/isolate what (?:the )?ads drove/i, 'claims a GA channel tab isolates causal ad outcomes'],
    [/Paid Bookings & Revenue/i, 'labels GA confirmation telemetry as paid bookings and revenue'],
    [/Organic Bookings & Revenue/i, 'labels GA confirmation telemetry as organic bookings and revenue'],
  ]

  // The eight-file list below misses the trust engine, the diagnostic producer, status
  // cards, monitoring detectors and the provenance layer. This scans EVERY production file instead, so
  // a new surface cannot appear outside the list and go unchecked.
  it('NO production file asserts GA telemetry is money', () => {
    const hits: string[] = []
    for (const f of ALL) {
      const rp = rel(f)
      if (rp.startsWith('lib/ga4/')) continue        // the modules that DEFINE the distinction
      for (const line of read(f).split('\n')) {
        // The previous exemption skipped ANY line containing `not` or `never`, so a false
        // claim could evade the guard simply by appending a disclaimer later in the same sentence.
        // The exemption is now NARROW and STRUCTURAL: only a line that is explicitly historical
        // (a "Historical note:") or an explicit prohibition/detector VERB is exempt, and the exemption
        // must appear BEFORE the offending phrase, not anywhere in the line.
        const EXEMPT = /(Historical note:|FAIL-IF:|must NOT|never say|DETECTS the claim|prohibit)/
        for (const [re, why] of FORBIDDEN) {
          const m = re.exec(line)
          if (!m) continue
          const before = line.slice(0, m.index)
          if (EXEMPT.test(before)) continue
          hits.push(`${rp} — ${why}: ${line.trim().slice(0, 100)}`)
        }
      }
    }
    expect(hits, 'a production string asserts GA telemetry is actual money or should drive an ad-performance judgement').toEqual([])
  })

  it('the trust engine cannot score GA telemetry as a verified money source', () => {
    const src = read(join(SRC, 'lib/trust/trust.ts'))
    // `ga4_actual` must NOT share the top score with the ledger, and must carry a hard ceiling.
    expect(src).not.toMatch(/src === 'outcome_business_total' \|\| src === 'ga4_confirmation_telemetry' \? 1/)
    expect(src).toMatch(/ga4_confirmation_telemetry/)
    expect(src).toMatch(/0\.45/)
    expect(src).toMatch(/no appointment identity/)
  })

  it('the reconciliation diagnostic never asserts 100% coverage just because GA responded', () => {
    const src = read(join(SRC, 'lib/diagnostics/reconciliation-report.ts'))
    expect(src).not.toMatch(/attributionCoverage: ga4Available \? 1 : null/)
  })

  it.each(SURFACES)('%s', (_label, file) => {
    const src = read(join(SRC, file))
    const hits: string[] = []
    for (const line of src.split('\n')) {
      for (const [re, why] of FORBIDDEN) if (re.test(line)) hits.push(`${why}: ${line.trim().slice(0, 120)}`)
    }
    expect(hits, 'this string instructs the model or the owner that GA telemetry is money').toEqual([])
  })

  // The phrase list catches particular sentences. This enforces the CONTRACT instead —
  // the permitted source vocabulary, and structured KEY NAMES, which the model reads as assertions.
  it('no structured output key claims GA events are bookings or revenue', () => {
    const offenders: string[] = []
    for (const f of ALL) {
      if (rel(f).startsWith('lib/ga4/')) continue
      for (const line of read(f).split('\n')) {
        const code = line.split('//')[0]
        // A KEY whose name pairs ga4 with bookings/revenue, e.g. `ga4_paid_bookings_30d:`.
        if (/\bga4[a-z_]*(bookings|revenue)[a-z_0-9]*\s*:/i.test(code) && !/persisted|column/i.test(line)) {
          offenders.push(`${rel(f)}: ${code.trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders, 'a structured key asserts GA events are bookings or revenue — rename it to confirmation_events / event_value').toEqual([])
  })

  it('the source vocabulary is closed — no module invents a synonym', () => {
    // Every SourceOfTruth literal in production must be one of the five permitted identifiers.
    const PERMITTED = new Set(['outcome_business_total', 'exact_paid_appointment_join',
                               'ga4_confirmation_telemetry', 'meta_modelled', 'computed'])
    const offenders: string[] = []
    for (const f of ALL) {
      for (const m of read(f).matchAll(/sourceOfTruth:\s*'([a-z_]+)'/g)) {
        if (!PERMITTED.has(m[1])) offenders.push(`${rel(f)}: sourceOfTruth: '${m[1]}'`)
      }
    }
    expect(offenders, 'an unrecognised source identifier appeared — extend the vocabulary deliberately, do not invent one').toEqual([])
  })

  it('the MCP instructions state the exact-join requirement and the unavailable-is-not-zero rule', () => {
    const src = withBookingNouns(read(join(SRC, 'mcp/instructions.ts')))
    expect(src).toMatch(/CONFIRMATION-EVENT TELEMETRY/)
    expect(src).toMatch(/aggregates[^.]*no booking identity/i)
    expect(src).toMatch(/EXACT booking-id join/)
    expect(src).toMatch(/Say "unavailable", never "0"/)
    expect(src).toMatch(/GA Paid Social can include other platforms/)
    expect(src).toMatch(/Meta view-through outcomes cannot carry GA session attribution/)
  })

  it('the profit playbook routes paid economics through the exact join, not GA campaign telemetry', () => {
    const src = read(join(SRC, 'lib/playbooks/playbooks.ts'))
    const profit = src.slice(src.indexOf("intent: 'profit_economics'"))
    const block = profit.slice(0, profit.indexOf('decision_rules'))
    expect(block).toMatch(/get_economics/)
    expect(block).not.toMatch(/tool: 'get_ga4_by_campaign'/)
  })
})

describe('the daily report cannot carry contradictory money language', () => {
  const promptSrc = withBookingNouns(read(join(SRC, 'lib/report/prompt-builder.ts')))

  it('never calls GA telemetry bookings, revenue, or a real efficiency', () => {
    // The exact contradiction the review found: the prompt printed "X bookings, $Y revenue" and a
    // "real paid efficiency" ROAS from GA aggregates, while the reconciliation block in the SAME
    // prompt stated GA contributes no booking and no dollar.
    expect(promptSrc).not.toMatch(/the real paid efficiency/)
    expect(promptSrc).not.toMatch(/GA4 PAID revenue ÷ Meta spend/)
    expect(promptSrc).not.toMatch(/todayPaidBookings|paidBookings30|paidRevenue30/)
  })

  it('states the GA block is telemetry and derives no ROAS or MER from it', () => {
    expect(promptSrc).toMatch(/GA4 CONFIRMATION-EVENT TELEMETRY — WEB ATTRIBUTION ONLY, NOT BOOKINGS AND NOT MONEY/)
    expect(promptSrc).toMatch(/Meta paid ROAS is NOT stated here/)
  })

  it('gives the model one unambiguous booking vocabulary', () => {
    expect(promptSrc).toMatch(/confirmed bookings/)
    expect(promptSrc).toMatch(/value-bearing bookings/)
    expect(promptSrc).toMatch(/zero-value bookings/)
    expect(promptSrc).toMatch(/NEVER call one a test/)
  })
})
