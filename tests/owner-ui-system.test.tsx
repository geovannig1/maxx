import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EvidenceMeta, SOURCE_ROLE_LABELS } from '@/components/sources/EvidenceMeta'
import { StatePanel, STATE_PANEL_COPY } from '@/components/ui/state-panel'
import { MAXX_NUMERIC_ANSWER_CONTRACT, MaxxEvidenceNotice } from '@/components/maxx/MaxxEvidenceNotice'
import { DateRangeControl } from '@/components/ui/DateRangeControl'

describe('owner-first UI system primitives', () => {
  it('renders source/date/scope evidence without blending source roles', () => {
    const html = renderToStaticMarkup(
      <EvidenceMeta
        source="outcomes"
        role="business_truth"
        window="Jul 20 → Aug 18"
        scope="account"
        freshness="Data through Aug 18"
        confidence="available"
      />,
    )

    expect(html).toContain('Outcomes')
    expect(html).toContain(SOURCE_ROLE_LABELS.business_truth)
    expect(html).toContain('Jul 20 → Aug 18')
    expect(html).toContain('account')
    expect(html).not.toContain('GA4')
    expect(html).not.toContain('Meta')
  })

  it('distinguishes empty, unavailable, unknown, blocked, and error states', () => {
    expect(Object.keys(STATE_PANEL_COPY).sort()).toEqual([
      'blocked',
      'empty',
      'error',
      'loading',
      'unavailable',
      'unknown',
    ])

    const unavailable = renderToStaticMarkup(
      <StatePanel state="unavailable" title="Acuity unavailable" description="Ledger could not be read." />,
    )
    const unknown = renderToStaticMarkup(
      <StatePanel state="unknown" title="Paid ROAS unknown" description="Exact appointment join has not proven it." />,
    )

    expect(unavailable).toContain('data-state="unavailable"')
    expect(unknown).toContain('data-state="unknown"')
    expect(unavailable).not.toEqual(unknown)
  })

  it('exposes Maxx numeric-answer contract in the chat UI layer', () => {
    expect(MAXX_NUMERIC_ANSWER_CONTRACT.requiredFields).toEqual([
      'value',
      'source',
      'sourceRole',
      'dateWindow',
      'scope',
      'freshness',
      'confidence',
      'caveat',
    ])
    expect(MAXX_NUMERIC_ANSWER_CONTRACT.neverBlend).toEqual([
      'outcome_business_truth',
      'ga4_confirmation_telemetry',
      'meta_modelled_attribution',
    ])

    const html = renderToStaticMarkup(<MaxxEvidenceNotice compact />)
    expect(html).toContain('source')
    expect(html).toContain('date')
    expect(html).toContain('scope')
    expect(html).toContain('never blends outcomes, GA4, and Meta')
  })

  it('keeps owner date controls on closed days with accessible hit targets', () => {
    const html = renderToStaticMarkup(
      <DateRangeControl
        value={{ preset: 'custom', from: '2026-08-01', to: '2026-08-20' }}
        onChange={() => {}}
      />,
    )

    expect((html.match(/max="\d{4}-\d{2}-\d{2}"/g) ?? []).length).toBe(2)
    expect((html.match(/min-height:44px/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
