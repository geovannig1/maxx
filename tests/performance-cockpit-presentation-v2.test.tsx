import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'

function claim(id: string, label: string, value: number | null, unit: 'money' | 'count' | 'ratio' = 'count') {
  return {
    claimId: id, metricKey: id, label, value, unit, formula: 'governed Meta formula', definitionVersion: 3,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'act-1' }, attributionScope: 'meta_platform_modelled',
    window: { start: '2026-04-06', end: '2026-04-24', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: { method: 'none', window: null }, asOf: '2026-04-25T10:00:00.000Z',
    availability: value === null ? { state: 'unavailable', blockerCodes: ['meta_source_unavailable'] } : { state: 'available', blockerCodes: [] },
    coverage: value === null ? { state: 'unknown', numerator: null, denominator: null } : { state: 'complete', numerator: 20, denominator: 20 },
    maturity: { state: 'settled', matureThrough: '2026-04-24' }, freshness: { state: 'fresh', observedAt: '2026-04-25T10:00:00.000Z', maxAgeHours: 30 },
    setupFingerprint: null, authority: { state: 'authoritative', policyVersion: 'performance-cockpit-v3' }, measurementKind: unit === 'ratio' ? 'derived' : 'modelled', inputClaimIds: [],
  }
}

function scorecardFixture(): PerformanceCockpitData {
  const claims = {
    spend: claim('spend', 'Meta spend', 963.4, 'money'), results: claim('results', 'Meta Results', 17),
    cost: claim('cost', 'Meta Cost / Result', 67.35, 'money'), roas: claim('roas', 'Meta Purchase ROAS', 2.18, 'ratio'),
    frequency: claim('frequency', 'Meta frequency', 1.29, 'ratio'), pacing: claim('pacing', 'Spend pacing', null, 'ratio'),
  }
  return {
    contractVersion: 4, account: { id: 'account-1', metaAccountId: 'act-1', name: 'Example Studio' }, controls: { range: claims.spend.window },
    clocks: { deliveryClosedThrough: '2026-04-24', conversionMatureThrough: '2026-04-24', synchronizedAt: '2026-04-25T10:00:00.000Z' }, claims,
    paidPerformance: { spendClaimId: 'spend', pacingClaimId: 'pacing', resultsClaimId: 'results', costPerResultClaimId: 'cost', purchaseRoasClaimId: 'roas', linkCtrClaimId: 'results', cpmClaimId: 'cost', frequencyClaimId: 'frequency', costPerLeadClaimId: null, reachClaimId: 'reach', optimizationRateClaimId: 'optrate' },
    partialToday: { date: '2026-04-25', state: 'unavailable', claimIds: [] }, comparison: { state: 'not_requested', window: null, claimIds: [] },
    sourceHealth: [{ plane: 'meta_delivery', state: 'available', synchronizedAt: '2026-04-25T10:00:00.000Z', blockerCodes: [], consumedByToday: true }], decisionIds: [], primaryDecisionId: null, primaryDecision: null,
  } as PerformanceCockpitData
}

describe('Meta performance cockpit presentation', () => {
  it('uses the canonical cockpit for the account headline without duplicating hierarchy', () => {
    const overview = readFileSync('src/components/performance/PerformanceOverview.tsx', 'utf8')
    expect(overview).toContain('`/api/cockpit?${params}`')
    expect(overview).not.toContain('/api/performance/account-scorecard')
  })

  it('renders Results, Delivery, Funnel, and Creative with exact range links', async () => {
    const { PerformancePresetStrip } = await import('@/components/performance/PerformanceOverview')
    const html = renderToStaticMarkup(<PerformancePresetStrip range={{ from: '2026-04-06', to: '2026-04-24' }} />)
    expect(html).toMatch(/Results/)
    expect(html).toMatch(/Delivery/)
    expect(html).toMatch(/Funnel/)
    expect(html).toMatch(/Creative/)
    expect(html).toContain('preset=results')
    expect(html).toContain('preset=delivery')
  })

  it('shows Meta purchase ROAS rather than an owner-facing checkout-return metric', async () => {
    const { AccountScorecardSection } = await import('@/components/performance/PerformanceOverview')
    const html = renderToStaticMarkup(<AccountScorecardSection scorecard={scorecardFixture()} />)
    expect((html.match(/data-primary-performance-fact=/g) ?? [])).toHaveLength(4)
    expect(html).toMatch(/Meta spend/)
    expect(html).toMatch(/Meta Results/)
    expect(html).toMatch(/Meta Cost \/ Result/)
    expect(html).toMatch(/Meta Purchase ROAS/)
    expect(html).toMatch(/2\.18×/)
    expect(html).not.toMatch(/checkout|Acuity|amount paid/i)
  })

  it('exposes account, campaign, ad-set, ad, and creative drilldowns with results as the default lens', async () => {
    const { PerformanceHierarchyNav } = await import('@/components/performance/PerformanceOverview')
    const html = renderToStaticMarkup(<PerformanceHierarchyNav range={{ from: '2026-04-06', to: '2026-04-24' }} />)
    expect(html).toMatch(/Account/)
    expect(html).toMatch(/Campaigns/)
    expect(html).toMatch(/Ad sets/)
    expect(html).toMatch(/Ads/)
    expect(html).toMatch(/Creative/)
    expect(html).toContain('/performance/campaigns?from=2026-04-06&amp;to=2026-04-24&amp;preset=results')
    // Creative remains its own destination. Its route now selects the creative view in the shared
    // reporting workspace, while the old URL still resolves rather than 404ing a bookmark.
    const creativePage = readFileSync('src/app/(dashboard)/creative/page.tsx', 'utf8')
    const creativeReport = readFileSync('src/components/reporting/CreativeReport.tsx', 'utf8')
    expect(creativePage).toContain('<ReportingWorkspace view="creative" />')
    expect(creativeReport).toContain('Creative performance')
    expect(creativeReport).toContain('<CreativeAsset')
    const shim = readFileSync('src/app/(dashboard)/performance/creative/page.tsx', 'utf8')
    expect(shim).toContain('redirect(')
    expect(shim).toContain("'/creative'")
  })
})
