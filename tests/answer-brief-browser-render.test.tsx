import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { parseAnswerBrief, renderAnswerBrief, type AnswerBriefClaim } from '@/lib/maxx/answer-brief'
import { AssistantTurn } from '@/components/maxx/MaxxChat'
import { ATTRIBUTION_SCOPES, createMetricClaim } from '@/lib/cockpit/contracts'

/**
 * The evidence line is asserted against the RENDERER, not against the string.
 *
 * `claimLine` was rewritten to lead with the value and carry provenance on following lines, and the
 * change was verified with `toContain` on `renderAnswerBrief`'s output. That is the artifact, not the
 * surface. `MaxxChat.tsx` mounts `react-markdown` with NO `remarkPlugins` — no `remark-breaks` — so a
 * soft line break inside a list item is lazy continuation, and CommonMark folds every line of the
 * claim into one wrapped paragraph. Measured on the real renderer: soft breaks emit zero `<br/>`.
 * The three-line shape the commit claimed to have shipped had never reached a browser.
 *
 * This file mounts the same `react-markdown` the component does. If the plugin set, the break syntax,
 * or the markdown-escaping behaviour ever changes, this fails — the raw-string assertions cannot.
 */

const claim = (overrides: Partial<AnswerBriefClaim> = {}): AnswerBriefClaim => createMetricClaim({
  claimId: 'meta.spend:2026-03-01:2026-03-22',
  metricKey: 'meta.spend', label: 'Meta spend', value: 1057.35, unit: 'money' as const,
  formula: null, definitionVersion: 1,
  source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account', evidencePlane: 'meta_delivery' },
  entity: { level: 'account', id: '100000000000777' },
  attributionScope: 'none',
  window: { start: '2026-03-01', end: '2026-03-22', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null },
  asOf: '2026-03-23T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 22, denominator: 22 },
  maturity: { state: 'settled', matureThrough: '2026-03-22' },
  freshness: { state: 'fresh', observedAt: '2026-03-23T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'sf', authority: { state: 'authoritative', policyVersion: 'cockpit-v3' },
  measurementKind: 'measured', inputClaimIds: [],
  ...overrides,
})

function html(claims: AnswerBriefClaim[]): string {
  const brief = parseAnswerBrief(JSON.stringify({
    summary: 'governed_claims',
    observations: [{ claim_ids: claims.map((c) => c.claimId) }],
    action_decision_ids: [],
    unavailable_claim_ids: [],
    next_check: null,
  }))
  // The COMPONENT, not a re-mount of react-markdown. The first version called `<ReactMarkdown>` bare
  // and called that "the exact mount from MaxxChat.tsx" — production passes `components={MD}`, and
  // `MD` is the thing most likely to change. Outcomes happened to agree because `MD` overrides no
  // `br`, which is exactly the kind of coincidence a fidelity claim should not rest on.
  return renderToStaticMarkup(
    <AssistantTurn turn={{ role: 'assistant', content: renderAnswerBrief(brief, claims) }} />,
  )
}

describe('the evidence line survives markdown rendering', () => {
  it('breaks into separate lines in the browser, not one wrapped paragraph', () => {
    const rendered = html([claim()])
    // Two hard breaks per claim: value → window → provenance. Zero is the bug this file exists for.
    expect([...rendered.matchAll(/<br\s*\/?>/g)]).toHaveLength(2)
  })

  it('renders the value as the emphasised opening of the line', () => {
    // `MD` styles `strong`, so the tag carries attributes — match the element, not a bare tag. The
    // previous exact-tag assertion only passed because the test mounted react-markdown WITHOUT the
    // component's overrides, which is the fidelity gap this file now closes.
    expect(html([claim()])).toMatch(/<strong[^>]*>Meta spend — \$1,057\.35<\/strong>/)
  })

  it('does not leak the break syntax as literal text', () => {
    // A backslash hard break that the parser does not understand renders as a visible "\".
    const rendered = html([claim()])
    expect(rendered).not.toContain('\\<')
    expect(rendered).not.toContain('\\\n')
    expect(rendered).not.toMatch(/\\\s*<br/)
  })

  it('names every provenance field rather than listing bare tokens', () => {
    // The first rewrite emitted `Provenance: meta, measured, authoritative` — three positional values
    // with no labels, in a system whose doctrine is that a measurement lane must be STATED.
    const rendered = html([claim()])
    for (const label of [
      'scope: account 100000000000777',
      'source: meta', 'measurement lane: measured', 'authority: authoritative',
      'availability: available', 'maturity: settled', 'attribution: ', 'freshness: fresh',
    ]) {
      expect(rendered).toContain(label)
    }
  })

  it.each(ATTRIBUTION_SCOPES)('renders %s as prose in the browser, never the raw token', (scope) => {
    // Totality over the enum. A scope token leaking through the renderer reads as a system identifier
    // to the one person who cannot look it up.
    const rendered = html([claim({ attributionScope: scope })])
    expect(rendered).toContain('attribution: ')
    expect(rendered).not.toMatch(new RegExp(`attribution: ${scope}[;<]`))
  })

  it('states once, in the browser, that no line carries a direction', () => {
    // `direction: not stated` was removed from every row and replaced by one notice. Deleting that
    // notice was invisible to the whole suite — the answer would silently stop saying that its
    // numbers carry no trend, which is the one thing a reader is most likely to assume they do.
    const rendered = html([claim()])
    expect(rendered).toContain('No line states a direction')
    expect(rendered).toContain('no prior-period comparison')
    // And it is said ONCE, not per claim — the repetition this replaced.
    expect([...rendered.matchAll(/No line states a direction/g)]).toHaveLength(1)
  })

  it('labels an unavailable claim with what blocked it', () => {
    // The only claimLine branch the new suite did not reach; it was covered by a pre-existing file,
    // so the rewritten line was one label short in both directions.
    const blocked = claim({
      claimId: 'meta.spend_pacing:2026-03-01:2026-03-22', metricKey: 'meta.spend_pacing',
      label: 'Spend pacing', value: null, unit: 'percent' as const,
      availability: { state: 'unavailable', blockerCodes: ['historical_budget_continuity_unproven'] },
    })
    const brief = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims', observations: [], action_decision_ids: [],
      unavailable_claim_ids: [blocked.claimId], next_check: null,
    }))
    const rendered = renderToStaticMarkup(<ReactMarkdown>{renderAnswerBrief(brief, [blocked])}</ReactMarkdown>)
    expect(rendered).toContain('blocked by: historical_budget_continuity_unproven')
    expect(rendered).toContain('scope: account 100000000000777')
    expect(rendered).toMatch(/<strong[^>]*>Spend pacing — unavailable<\/strong>/)
  })

  it('keeps each claim a separate list item when several are cited', () => {
    const second = claim({
      claimId: 'meta.impressions:2026-03-01:2026-03-22', metricKey: 'meta.impressions',
      label: 'Meta impressions', value: 59134, unit: 'count' as const,
    })
    const rendered = html([claim(), second])
    expect([...rendered.matchAll(/<li[^>]*>/g)]).toHaveLength(2)
    expect([...rendered.matchAll(/<br\s*\/?>/g)]).toHaveLength(4)
  })
})

describe('a trend survives the real renderer', () => {
  /**
   * The `+` and the `compared against` clause are asserted here, in HTML, and not only against
   * `renderAnswerBrief`'s raw string.
   *
   * This file exists because a previous version of `claimLine` was verified against the string and
   * shipped a three-line shape that CommonMark collapsed into one wrapped paragraph — the assertion
   * held and the browser disagreed. A leading `+` is exactly the kind of character markdown can eat:
   * at the start of a line it opens a list.
   */
  const PRIOR = { start: '2026-03-15', end: '2026-04-03', basis: 'closed_account_days' as const, timezone: 'America/New_York' as const }
  const trend = (value: number, label: string, claimId: string) => createMetricClaim({
    claimId, metricKey: 'meta.spend_change', label, value, unit: 'percent', formula: null,
    definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'h', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'act_123' }, attributionScope: 'none',
    window: { start: '2026-04-04', end: '2026-04-23', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: { method: 'prior_equal_period', window: PRIOR },
    asOf: '2026-04-24T12:00:00.000Z',
    availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 2, denominator: 2 },
    maturity: { state: 'settled', matureThrough: '2026-04-23' },
    freshness: { state: 'fresh', observedAt: '2026-04-24T12:00:00.000Z', maxAgeHours: 26 },
    setupFingerprint: null, authority: { state: 'context', policyVersion: 'cockpit-v3' },
    measurementKind: 'derived',
    // An available derived claim must cite its inputs — the schema enforces it, and a real trend
    // cites both sides of the comparison.
    inputClaimIds: ['meta.spend:2026-04-04:2026-04-23', 'meta.spend:2026-03-15:2026-04-03'],
  })

  it('renders the + as text, not as markdown syntax', () => {
    const out = html([trend(41.83, 'Meta spend vs prior period', 'c-up')])
    expect(out).toContain('+41.83%')
  })

  it('renders a fall with its minus', () => {
    expect(html([trend(-12.4, 'Meta Results vs prior period', 'c-down')])).toContain('-12.4%')
  })

  it('shows what it was compared against, in the browser', () => {
    expect(html([trend(41.83, 'Meta spend vs prior period', 'c-up2')]))
      .toContain('compared against: 2026-03-15 to 2026-04-03')
  })

  it('does not print the no-direction disclaimer beneath a trend', () => {
    expect(html([trend(41.83, 'Meta spend vs prior period', 'c-up3')]))
      .not.toContain('No line states a direction')
  })

  it('keeps the trend on its own line rather than merging it into the row above', () => {
    const out = html([trend(41.83, 'Meta spend vs prior period', 'c-up4')])
    expect(out).toContain('<br/>')
  })
})
