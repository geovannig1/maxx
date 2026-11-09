import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMetricClaim, type MetricClaim } from '@/lib/cockpit/contracts'
import { parseAnswerBriefValue, renderAnswerBrief } from '@/lib/maxx/answer-brief'
import { governMaxxAnswer } from '@/lib/maxx/chat-governance'
import { splitAnswerSections } from '@/lib/maxx/answer-sections'
import { AssistantTurn, GovernanceLine } from '@/components/maxx/MaxxChat'
import type { MaxxToolEvidence } from '@/lib/maxx/chat-evidence'

/**
 * Summary first, evidence on request — asserted on the rendered COMPONENT, not on the string, because
 * the string is the artifact and the bubble is the surface.
 */

const spend: MetricClaim = createMetricClaim({
  claimId: 'meta.spend:2026-03-01:2026-03-28', metricKey: 'meta.spend', label: 'Meta spend', value: 1057.35,
  unit: 'money', formula: null, definitionVersion: 1,
  source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account', evidencePlane: 'meta_delivery' },
  entity: { level: 'account', id: '100000000000777' }, attributionScope: 'none',
  window: { start: '2026-03-01', end: '2026-03-28', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null }, asOf: '2026-03-29T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 28, denominator: 28 },
  maturity: { state: 'settled', matureThrough: '2026-03-28' },
  freshness: { state: 'fresh', observedAt: '2026-03-29T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'sf', authority: { state: 'authoritative', policyVersion: 'cockpit-v3' },
  measurementKind: 'measured', inputClaimIds: [],
})
const roas: MetricClaim = createMetricClaim({
  ...spend, claimId: 'meta.purchase_roas:2026-03-01:2026-03-28', metricKey: 'meta.purchase_roas',
  label: 'Meta Purchase ROAS', value: null, unit: 'ratio',
  availability: { state: 'unavailable', blockerCodes: ['stale_insight_source'] },
  coverage: { state: 'unknown', numerator: null, denominator: null },
})

const EVIDENCE: MaxxToolEvidence[] = [{
  tool: 'get_performance_cockpit', sources: ['Meta'], dateWindow: '2026-03-01..2026-03-28', scope: 'account',
  observedAt: '2026-03-29T12:00:00.000Z', freshness: 'fresh', availability: 'returned', caveat: 'none',
}]

function answer(): string {
  const brief = parseAnswerBriefValue({
    summary: 'governed_claims', observations: [{ claim_ids: [spend.claimId] }],
    action_decision_ids: [], unavailable_claim_ids: [roas.claimId], next_check: null,
  })
  return governMaxxAnswer(renderAnswerBrief(brief, [spend, roas]), EVIDENCE, 'server_composed')
}

describe('the governed answer text', () => {
  it('opens with the summary and puts notice, source roles and claims after the evidence heading', () => {
    const text = answer()
    const { lead, evidenceLabel, evidence } = splitAnswerSections(text)
    expect(lead).toBe('Mar 1 – Mar 28, 2026: Meta spend came to $1,057.35. '
      + "Meta Purchase ROAS isn't available for this window because the Meta delivery data behind this is out of date.")
    expect(evidenceLabel).toBe('Evidence (2 claims)')
    for (const part of ['DIAGNOSTIC CHAT', '**Source roles**', '**Evidence used**', '**Meta spend — $1,057.35**', '**Unavailable**']) {
      expect(evidence).toContain(part)
      expect(lead).not.toContain(part)
    }
  })

  it('puts the recommended next step in the lead, from the persisted decision, not the model', () => {
    const brief = parseAnswerBriefValue({
      summary: 'governed_claims', observations: [{ claim_ids: [spend.claimId] }],
      action_decision_ids: ['decision-1'], unavailable_claim_ids: [], next_check: null,
    })
    const decisions = new Map([['decision-1', {
      id: 'decision-1', persisted: true as const, final: true as const, record_type: 'action_decisions' as const,
      policy_version: 5, authority_tier: 'owner_review' as const, approval_state: 'pending' as const,
      owner_copy: 'FOR OWNER REVIEW: inspect the governed proposal.',
      lineage: { source_kind: 'recommendation' as const, source_id: 'rec-1' },
    }]])
    const text = governMaxxAnswer(renderAnswerBrief(brief, [spend], decisions), EVIDENCE, 'server_composed')
    const { lead, evidence } = splitAnswerSections(text)
    expect(lead).toContain('**Recommended next step:** FOR OWNER REVIEW: inspect the governed proposal — owner review, awaiting your approval')
    expect(evidence).toContain('Persisted final ActionDecision: decision-1')
  })

  it('keeps a refusal as the lead, with the disclosure after the heading', () => {
    const text = governMaxxAnswer('The answer was withheld.', EVIDENCE, 'server_composed')
    expect(text.startsWith('The answer was withheld.\n\n**Evidence**')).toBe(true)
    expect(text).toContain('DIAGNOSTIC CHAT')
  })
})

describe('the assistant bubble', () => {
  const html = () => renderToStaticMarkup(<AssistantTurn turn={{ role: 'assistant', content: answer(), tools: ['get_performance_cockpit'] }} />)

  it('renders the summary before a collapsed evidence disclosure', () => {
    const rendered = html()
    const details = rendered.indexOf('<details data-answer-evidence')
    expect(details).toBeGreaterThan(0)
    expect(rendered.indexOf('Meta spend came to $1,057.35')).toBeLessThan(details)
    expect(rendered.indexOf('Meta spend — $1,057.35')).toBeGreaterThan(details)
  })

  it('is closed by default and labelled by a native summary a keyboard and screen reader can operate', () => {
    const rendered = html()
    const tag = rendered.match(/<details data-answer-evidence[^>]*>/)![0]
    expect(tag).not.toMatch(/\bopen\b/)
    expect(rendered).toMatch(/<summary[^>]*>.*Evidence \(2 claims\)<\/summary>/)
    // The chevron is decoration; the label is the accessible name.
    expect(rendered).toMatch(/<summary[^>]*><svg[^>]*aria-hidden="true"/)
  })

  it('keeps the checked-tools line small and outside the bubble', () => {
    expect(html()).toContain('Checked: performance cockpit')
  })

  it('renders an answer without an evidence heading whole, as before', () => {
    const rendered = renderToStaticMarkup(<AssistantTurn turn={{ role: 'assistant', content: 'Plain **text**.' }} />)
    expect(rendered).not.toContain('<details')
    expect(rendered).toContain('Plain <strong')
  })
})

describe('the governance line', () => {
  it('is one line with a "How Maxx answers" disclosure, closed by default', () => {
    const rendered = renderToStaticMarkup(<GovernanceLine />)
    expect(rendered).toMatch(/<details data-governance-line[^>]*>/)
    expect(rendered.match(/<details[^>]*>/)![0]).not.toMatch(/\bopen\b/)
    expect(rendered).toContain('How Maxx answers')
    expect(rendered).toContain('Numeric answers require source, date, scope, freshness, confidence, and caveat.')
  })
})
