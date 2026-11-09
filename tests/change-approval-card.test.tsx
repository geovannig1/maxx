import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { ChangeApprovalCard, cardControls, type ChangeCard } from '@/components/changes/ChangeApprovalCard'
import { resultMessage } from '@/components/changes/ChangeReviewList'

// ADR-059 approval card: everything the owner approves is on the card (preview, evidence, risk,
// rollback plan, expiry, who initiated it) and the controls match what the server will do.

const change = (overrides: Partial<ChangeCard> = {}): ChangeCard => ({
  id: 'change-1', action_decision_id: 'decision-1', status: 'pending', action_type: 'adjust_budget', entity_level: 'adset',
  meta_entity_id: '120000000000000203', params: { new_daily_budget: 3000 },
  before_state: { daily_budget: '260000' }, after_state: null,
  preview: 'Raise ad set "ASC · Broad US" daily budget $2,600.00 → $3,000.00 (+15.4%).', reason: 'Owner-initiated from a Maxx decision.',
  confidence: null, risk_level: 'high', rollback_plan: 'Restore the previous daily budget from before_state.', requested_by: 'owner@example.com',
  created_at: '2026-11-08T12:00:00Z', expires_at: '2099-11-15T12:00:00Z', executed_at: null,
  evidence: 'FOR OWNER REVIEW. Lowest cost per booking (Meta-modelled estimate).', data_source: 'meta_live_read',
  initiated_by: 'owner', rollback_of: null, step_override: false, result: null,
  ...overrides,
})

const html = (card: ChangeCard, writeMode: 'on' | 'off' | 'demo' = 'off') =>
  renderToStaticMarkup(<ChangeApprovalCard change={card} writeMode={writeMode} onResult={() => {}} />)

describe('change approval card', () => {
  it('shows the preview, evidence, risk, rollback plan, expiry and initiator', () => {
    const out = html(change())
    expect(out).toContain('Raise ad set &quot;ASC · Broad US&quot; daily budget $2,600.00 → $3,000.00 (+15.4%).')
    expect(out).toContain('Lowest cost per booking (Meta-modelled estimate).')
    expect(out).toMatch(/high risk/)
    expect(out).toContain('Restore the previous daily budget')
    expect(out).toMatch(/Expires/)
    expect(out).toContain('You proposed this')
  })

  it('offers Approve & apply only when something will apply, and says so when writes are off', () => {
    expect(cardControls(change(), 'on')).toEqual(['approve_and_apply', 'reject'])
    expect(cardControls(change(), 'demo')).toEqual(['approve_and_apply', 'reject'])
    expect(cardControls(change(), 'off')).toEqual(['approve', 'reject'])
    expect(html(change(), 'off')).toMatch(/writes are off; turn on WRITE_MODE_ENABLED to apply/)
    // An approved row can be applied later once writes are on; with writes off it waits.
    expect(cardControls(change({ status: 'approved' }), 'on')).toEqual(['execute'])
    expect(cardControls(change({ status: 'approved' }), 'off')).toEqual([])
  })

  it('offers Roll back on an executed pause, activate or budget change, never on a duplicate or a rollback', () => {
    expect(cardControls(change({ status: 'executed' }), 'on')).toEqual(['rollback'])
    expect(cardControls(change({ status: 'executed', action_type: 'duplicate_adset' }), 'on')).toEqual([])
    expect(cardControls(change({ status: 'executed', rollback_of: 'change-0' }), 'on')).toEqual([])
  })

  it('refuses every control on an expired or lineage-less request except reject', () => {
    expect(cardControls(change({ expires_at: '2000-01-01T00:00:00Z' }), 'on')).toEqual(['reject'])
    expect(html(change({ expires_at: '2000-01-01T00:00:00Z' }))).toMatch(/Expired/)
    expect(cardControls(change({ action_decision_id: null }), 'on')).toEqual(['reject'])
  })

  it('shows the verified before/after, and labels a demo result as simulated', () => {
    const executed = change({
      status: 'executed', executed_at: '2026-11-08T13:00:00Z', after_state: { daily_budget: '300000' },
      result: { simulated: true, label: 'Demo: simulated — applied to the sample data only; nothing was sent to Meta.' },
    })
    const out = html(executed, 'demo')
    expect(out).toMatch(/Before/)
    expect(out).toMatch(/After/)
    expect(out).toContain('Demo: simulated')
  })

  it('maps every server result to an honest message (simulated and writes-off included)', () => {
    expect(resultMessage('approve', 'DEMO_SIMULATED')).toMatchObject({ ok: true, text: expect.stringMatching(/^Demo: simulated/) })
    expect(resultMessage('approve', 'approved').text).toMatch(/writes are off; turn on WRITE_MODE_ENABLED to apply/)
    expect(resultMessage('approve', 'STEP_LIMIT_EXCEEDED').ok).toBe(false)
  })

  it('ADR-062: a campaign plan request has its own lineage, a multi-line preview, resume and rollback', () => {
    const plan = change({
      action_decision_id: null, campaign_plan_version_id: 'version-1', action_type: 'create_campaign_paused', entity_level: 'account',
      meta_entity_id: 'act_1', params: { plan_version_id: 'version-1', spec_hash: 'a'.repeat(64) },
      preview: 'Creates 1 campaign, 1 ad set(s) and 3 ad(s), every one PAUSED.\nCreate campaign "Spring" (OUTCOME_SALES): PAUSED.',
    })
    expect(cardControls(plan, 'on')).toEqual(['approve_and_apply', 'reject'])
    expect(cardControls(plan, 'off')).toEqual(['approve', 'reject'])
    const out = html(plan, 'on')
    expect(out).toContain('Create campaign (paused)')
    expect(out).toContain('whitespace-pre-line')
    expect(out).toMatch(/every one PAUSED/)
    expect(out).not.toMatch(/Historical request/)
    const failed = change({ ...plan, status: 'failed', result: { status: 'PARTIAL_FAILURE', message: 'Some objects were created, all PAUSED.', objects: [{ kind: 'campaign', meta_id: '9000' }] } })
    expect(cardControls(failed, 'on')).toEqual(['execute', 'rollback'])
    expect(cardControls(failed, 'off')).toEqual(['rollback'])
    expect(html(failed, 'on')).toContain('Resume creation')
    expect(html(failed, 'on')).toContain('campaign 9000')
    expect(cardControls(change({ ...plan, status: 'executed' }), 'on')).toEqual(['rollback'])
    expect(resultMessage('approve', 'CREATED_PAUSED')).toMatchObject({ ok: true })
    expect(resultMessage('approve', 'PARTIAL_FAILURE')).toMatchObject({ ok: false })
  })

  it('shows a campaign plan preview with each ad\'s full payload in its own collapsible section (security review L7)', () => {
    const preview = [
      'Creates 1 campaign, 1 ad set(s) and 2 ad(s), every one PAUSED.',
      'Create campaign "Spring" (OUTCOME_SALES): PAUSED.',
      '  Ad set 1 "Broad US": optimises for OFFSITE_CONVERSIONS (Purchase, pixel 111): PAUSED.',
      '    Ad "Ad 1": new creative from image hash001: PAUSED.',
      '      Primary text: Book a bright studio by the hour.',
      '      URL parameters: utm_source=meta',
      '    Ad "Ad 2": existing creative 777: PAUSED.',
      '      Runs creative 777 as it is.',
    ].join('\n')
    const out = html(change({ action_type: 'create_campaign_paused', entity_level: 'account', action_decision_id: null, campaign_plan_version_id: 'version-1', preview }))
    expect(out.match(/<details/g)).toHaveLength(2)
    expect(out).toContain('Primary text: Book a bright studio by the hour.')
    expect(out).toContain('URL parameters: utm_source=meta')
    expect(out).toMatch(/<summary[^>]*>Ad &quot;Ad 1&quot;: new creative from image hash001: PAUSED.<\/summary>/)
  })

  it('offers only "Recover stuck change" while a run of the change is stuck (security review M1)', () => {
    const stuck = change({ status: 'approved', stuck_since: '2026-11-08T11:00:00Z' })
    expect(cardControls(stuck, 'on')).toEqual(['recover'])
    expect(cardControls(change({ status: 'approved' }), 'on')).toEqual(['execute'])
    expect(html(stuck, 'on')).toMatch(/Recover stuck change/)
  })
})
