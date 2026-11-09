import { describe, it, expect } from 'vitest'
import { metricProvenance, provenanceSummary, granularityLabel } from '@/lib/metrics/provenance'

describe('metric provenance labeling', () => {
  it('each source labels ITSELF — GA telemetry is never rendered as the ledger', () => {
    const p = metricProvenance('ga4_confirmation_telemetry', { granularity: 'campaign' })
    expect(p.provenance).toBe('estimated')   // GA telemetry is an ESTIMATE, never an actual
    expect(p.short).toMatch(/GA telemetry/)
    expect(p.tone).toBe('warning')   // telemetry, so the chip warns rather than reassures
  })

  it('Meta-pixel values are labeled estimated, never actual', () => {
    const p = metricProvenance('meta_modelled')
    expect(p.provenance).toBe('estimated')
    expect(p.short).toMatch(/Meta est/)
  })

  it('blended MER is labeled blended + "NOT a paid campaign ROAS"', () => {
    const p = metricProvenance('ga4_confirmation_telemetry', { blended: true, granularity: 'account' })
    expect(p.provenance).toBe('blended')
    expect(p.long).toMatch(/NOT a paid campaign ROAS/i)
    expect(p.tone).toBe('warning')
  })

  it('low attribution coverage downgrades a GA4-actual ROAS to attribution-limited', () => {
    const p = metricProvenance('ga4_confirmation_telemetry', { attributionCoverage: 0.2, granularity: 'campaign' })
    expect(p.provenance).toBe('attribution_limited')
    expect(p.short).toMatch(/20%/)
  })

  it('good coverage does NOT promote GA telemetry to actual', () => {
    expect(metricProvenance('ga4_confirmation_telemetry', { attributionCoverage: 0.9 }).provenance).toBe('estimated')
    // Only a ledger-anchored source may read as `actual`.
    expect(metricProvenance('outcome_business_total', { attributionCoverage: 0.9 }).provenance).toBe('actual')
    expect(metricProvenance('exact_paid_appointment_join', { attributionCoverage: 0.9 }).provenance).toBe('actual')
  })

  it('unknown source is flagged, not silently trusted', () => {
    const p = metricProvenance(undefined)
    expect(p.provenance).toBe('unknown')
    expect(p.tone).toBe('warning')
  })

  it('summary combines provenance + granularity', () => {
    expect(provenanceSummary(metricProvenance('ga4_confirmation_telemetry', { granularity: 'campaign' }))).toBe('GA telemetry · campaign-level')
    expect(granularityLabel('account')).toBe('account-level')
    expect(granularityLabel(null)).toBe('')
  })
})
