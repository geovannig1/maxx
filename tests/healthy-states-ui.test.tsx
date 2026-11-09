import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { computeStatusCards } from '@/lib/trust/status-cards'
import type { TrustScore } from '@/lib/trust/trust'
import { PlainTrustVerdict, overallVerdict, plainTrustRows } from '@/components/diagnostics/PlainTrustVerdict'
import { GovernedLaunchReadiness, launchReadinessChecks, readinessSummary } from '@/components/ledger/GovernedLaunchReadiness'
import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'

/**
 * Healthy evidence reads as healthy; anything short of it does not. Both directions are asserted,
 * because a component that can only ever say "blocked" and one that always says "verified" are the
 * same defect.
 */

const trust: TrustScore = { score: 60, level: 'moderate', meetsBar: false, factors: [], ceilings: [], gaps: [], headline: 'moderate' }
const utm = (coverage: number) => ({ adsTotal: 4, adsCorrect: Math.round(coverage * 4), adsMissing: 4 - Math.round(coverage * 4), adsMisconfigured: 0, adsUnverified: 0, coverage })

function healthyCards() {
  return computeStatusCards({ ga4Available: true, utm: utm(1), attributedShare: 0.8, dataAgeHours: 3, integrityStatus: 'aligned', trust, outcomeBasis: 'telemetry_only' })
}

describe('plain trust verdict on Diagnostics', () => {
  it('reads Healthy, with every data row Verified, when the evidence is complete and healthy', () => {
    const rows = plainTrustRows(healthyCards(), 'aligned')
    expect(rows.filter((row) => row.label !== 'Paid ROAS').every((row) => row.state === 'verified')).toBe(true)
    expect(overallVerdict(rows)).toEqual({ tone: 'healthy', text: 'Healthy: every data check passes.' })
    const html = renderToStaticMarkup(<PlainTrustVerdict cards={healthyCards()} integrity="aligned" />)
    expect(html).toContain('data-trust-verdict="healthy"')
    expect(html.match(/>Verified</g)).toHaveLength(4)
  })

  it('keeps Paid ROAS unavailable even when everything else is healthy', () => {
    const paid = plainTrustRows(healthyCards(), 'aligned').find((row) => row.label === 'Paid ROAS')!
    expect(paid.state).toBe('unavailable')
    expect(paid.detail).toMatch(/not a pass and not zero/)
  })

  it('does not read healthy when spend sources disagree', () => {
    const rows = plainTrustRows(healthyCards(), 'mismatch')
    expect(overallVerdict(rows).tone).toBe('attention')
  })

  it('does not read healthy when a check could not be measured', () => {
    const cards = computeStatusCards({ ga4Available: false, dataAgeHours: 3, integrityStatus: 'aligned', trust, outcomeBasis: 'telemetry_only' })
    const verdict = overallVerdict(plainTrustRows(cards, 'aligned'))
    expect(verdict.tone).not.toBe('healthy')
  })
})

type Row = PerformanceCockpitData['sourceHealth'][number]
const row = (plane: Row['plane'], state: Row['state'], blockerCodes: string[] = []): Row =>
  ({ plane, state, synchronizedAt: '2026-11-07T13:00:00Z', blockerCodes, consumedByToday: true })

describe('governed launch readiness', () => {
  it('verifies every plane whose own health row is available, and leaves unread checks not measured', () => {
    const checks = launchReadinessChecks([row('meta_delivery', 'available'), row('outcome_business', 'available'), row('ga4_telemetry', 'available')])
    expect(checks.filter((c) => c.state === 'verified').map((c) => c.key)).toEqual(['meta_delivery', 'outcome_business', 'ga4_telemetry'])
    expect(checks.filter((c) => c.state === 'not_measured').map((c) => c.key)).toEqual(['paid_touch_identity', 'browser_server_dedup'])
    expect(readinessSummary(checks)).toEqual({ tone: 'ready', text: 'All 3 measured checks pass. 2 more need evidence this page does not read.' })
    const html = renderToStaticMarkup(<GovernedLaunchReadiness checks={checks} />)
    expect(html).toContain('data-launch-readiness="ready"')
    expect(html.match(/>Verified</g)).toHaveLength(3)
  })

  it('never claims Verified for a plane nobody read, and never Blocked for a check with no reader', () => {
    const checks = launchReadinessChecks([row('meta_delivery', 'available')])
    expect(checks.find((c) => c.key === 'outcome_business')!.state).toBe('not_measured')
    expect(renderToStaticMarkup(<GovernedLaunchReadiness checks={checks} />)).not.toMatch(/>(?:Blocked|Unverified)</)
  })

  it('needs attention when Meta delivery is unavailable, naming why in owner words', () => {
    const checks = launchReadinessChecks([row('meta_delivery', 'unavailable', ['stale_insight_source'])])
    const meta = checks.find((c) => c.key === 'meta_delivery')!
    expect(meta.state).toBe('attention')
    expect(meta.detail).toContain('the Meta delivery data behind this is out of date')
    expect(readinessSummary(checks).tone).toBe('attention')
  })

  it('treats a failed source-health read as attention for Meta, not a pass', () => {
    const checks = launchReadinessChecks(null)
    expect(checks.find((c) => c.key === 'meta_delivery')!.state).toBe('attention')
    expect(readinessSummary(checks).tone).toBe('attention')
  })
})
