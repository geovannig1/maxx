import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ManifestEditor } from '@/components/ledger/ManifestEditor'
import {
  assessManifestAcceptance,
  defaultManifest,
  type ManifestRow,
} from '@/lib/recommendations/manifest'
import type { LedgerRow } from '@/lib/recommendations/setup-ledger'

const state = vi.hoisted(() => ({
  insert: vi.fn(async () => 'decision-1'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }),
    },
  })),
}))

vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'ad_accounts') {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: { id: 'account-1' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'ad_setup_decisions') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.update = () => chain
        chain.maybeSingle = async () => ({
          data: {
            id: 'legacy-launch-1',
            ad_account_id: 'account-1',
            entity_key: 'legacy-launch',
            entity_name: 'Legacy launch',
            entity_type: 'campaign',
            setting_category: 'objective',
            proposed_value: 'OUTCOME_LEADS',
            final_value: 'OUTCOME_LEADS',
            actual_launched_value: null,
            conflicts_with_prior: false,
            prior_decision_id: null,
            user_decision: 'accepted',
            action_taken: false,
            origin: 'launch_setup',
          },
          error: null,
        })
        chain.single = async () => ({ data: { id: 'legacy-launch-1' }, error: null })
        return chain
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/recommendations/setup-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recommendations/setup-ledger')>()
  return {
    ...actual,
    insertSetupDecision: state.insert,
    latestDecisionForSetting: vi.fn(async () => null),
  }
})

const VALID_PLAN_HASH = `sha256:${'a'.repeat(64)}`

function planProposal(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    setting_category: 'objective',
    setting_name: 'Campaign objective',
    proposed_value: 'Awareness',
    reason: 'The approved cold-journey plan is designed to earn qualified homepage visits before booking.',
    proposal_status: 'proposed',
    blocker_codes: [],
    plan_source: {
      plan_id: 'plan-1',
      revision: 'rev-3',
      content_hash: VALID_PLAN_HASH,
    },
    ...overrides,
  }
}

function legacyLaunchRow(): LedgerRow {
  return {
    id: 'legacy-launch-1',
    entity_type: 'campaign',
    entity_key: 'example-studio-launch',
    entity_name: 'Example Studio — Launch',
    setting_category: 'objective',
    setting_name: 'Campaign objective',
    previous_value: null,
    proposed_value: 'OUTCOME_LEADS',
    final_value: 'OUTCOME_LEADS',
    actual_launched_value: null,
    origin: 'launch_setup',
    reason: 'Legacy unbound setup row',
    user_decision: 'accepted',
    decision_note: null,
    decided_by: 'owner@example.com',
    action_taken: false,
    conflicts_with_prior: false,
    prior_decision_id: null,
    prior_deprecated: false,
    change_summary: null,
    why_changed: null,
    switch_risk: null,
    follow_up_date: null,
    created_at: '2026-07-01T00:00:00Z',
  }
}

describe('manifest acceptance is structural, not prose-based', () => {
  it('keeps every context-free manifest row blocked and free of paste-ready setup values', () => {
    const rows = defaultManifest('2026-07-30')
    const proposedValues = rows.map((row) => row.proposed_value).join('\n')

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).toMatchObject({
        proposal_status: 'blocked',
        blocker_codes: expect.arrayContaining(['campaign_plan_missing']),
      })
      expect(row.proposed_value).toMatch(/^BLOCKED —/)
      expect(assessManifestAcceptance(row, row.proposed_value)).toMatchObject({
        allowed: false,
        reason_codes: expect.arrayContaining(['campaign_plan_missing', 'manifest_blocked']),
      })
    }
    expect(proposedValues).not.toMatch(
      /utm_source=|\{\{campaign\.|AppointmentConfirmed|Continuous from launch|Cold Professional|\$\d|\b2026-\d{2}-\d{2}\b/i,
    )
  })

  it('rejects a blocked placeholder even when the owner replaces the literal BLOCKED text', () => {
    const row = defaultManifest('2026-07-30')[0]

    expect(row.proposal_status).toBe('blocked')
    expect(row.blocker_codes).toContain('campaign_plan_missing')
    expect(assessManifestAcceptance(row, 'Awareness')).toEqual(expect.objectContaining({
      allowed: false,
      reason_codes: expect.arrayContaining(['campaign_plan_missing']),
    }))
  })

  it('does not mistake caller-supplied plan fields for verified provenance', () => {
    expect(assessManifestAcceptance(planProposal(), 'Awareness')).toEqual(expect.objectContaining({
      allowed: false,
      reason_codes: expect.arrayContaining(['campaign_plan_not_implemented']),
    }))
    expect(assessManifestAcceptance(planProposal({ reason: '' }), 'Awareness').reason_codes).toContain('rationale_missing')
    expect(assessManifestAcceptance(planProposal({ plan_source: undefined }), 'Awareness').reason_codes).toContain('campaign_plan_source_missing')
    expect(assessManifestAcceptance(planProposal({
      plan_source: { plan_id: 'plan-1', revision: '', content_hash: VALID_PLAN_HASH },
    }), 'Awareness').reason_codes).toContain('campaign_plan_revision_missing')
    expect(assessManifestAcceptance(planProposal({
      plan_source: { plan_id: 'plan-1', revision: 'rev-3', content_hash: 'not-a-hash' },
    }), 'Awareness').reason_codes).toContain('campaign_plan_hash_invalid')
  })

  it('renders context-free rows as disabled instead of offering an approval side door', () => {
    const rows = defaultManifest('2026-07-30')
    const html = renderToStaticMarkup(<ManifestEditor defaults={rows} existing={[]} />)

    expect(html.match(/<button[^>]*disabled=""[^>]*>Awaiting plan<\/button>/g)).toHaveLength(rows.length)
    expect(html).not.toContain('>Approve &amp; record</button>')
  })

  it('keeps even a well-formed caller-supplied plan row disabled until server verification exists', () => {
    const html = renderToStaticMarkup(
      <ManifestEditor defaults={[planProposal()]} existing={[]} />
    )

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Awaiting plan<\/button>/)
    // The exact blocking code is asserted via data-blocked-by. It used to be asserted by
    // finding the raw token in the visible text, which only passed because the enum was
    // being printed at the operator; the reason is now shown as prose.
    expect(html).toContain('data-blocked-by="campaign_plan_not_implemented"')
    expect(html).toContain('An approved campaign plan does not exist yet')
    expect(html).not.toMatch(/>[^<]*campaign_plan_not_implemented[^<]*</)
  })

  it('renders legacy unbound launch rows as read-only history, not a Record launched action', () => {
    const html = renderToStaticMarkup(
      <ManifestEditor defaults={[defaultManifest('2026-07-30')[0]]} existing={[legacyLaunchRow()]} />
    )

    expect(html).toContain('Legacy launch row is read-only')
    expect(html).not.toContain('Record launched')
  })
})

describe('setup-decision API enforces the same plan lineage', () => {
  beforeEach(() => state.insert.mockClear())

  it('rejects a direct POST of a literal BLOCKED placeholder without plan provenance', async () => {
    const { POST } = await import('@/app/api/setup-decisions/route')
    const req = new NextRequest('http://localhost/api/setup-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'campaign',
        planned_name: 'Unsafe launch',
        setting_category: 'objective',
        setting_name: 'Campaign objective',
        proposed_value: 'BLOCKED — missing plan',
        final_value: 'Awareness',
        origin: 'launch_setup',
        reason: 'placeholder',
        user_decision: 'accepted',
        proposal_status: 'blocked',
        blocker_codes: ['campaign_plan_missing'],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'USE_CAMPAIGN_PLANS',
      reason_codes: expect.arrayContaining(['use_campaign_plans']),
    }))
    expect(state.insert).not.toHaveBeenCalled()
  })

  it('rejects even well-formed caller plan fields because no server-side plan repository exists', async () => {
    const { POST } = await import('@/app/api/setup-decisions/route')
    const req = new NextRequest('http://localhost/api/setup-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'campaign',
        planned_name: 'Plan-backed launch',
        setting_category: 'objective',
        setting_name: 'Campaign objective',
        proposed_value: 'Awareness',
        final_value: 'Awareness',
        origin: 'launch_setup',
        reason: 'The approved cold-journey plan is designed to earn qualified homepage visits before booking.',
        user_decision: 'accepted',
        proposal_status: 'proposed',
        blocker_codes: [],
        campaign_plan_id: 'plan-1',
        campaign_plan_revision: 'rev-3',
        campaign_plan_hash: VALID_PLAN_HASH,
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'USE_CAMPAIGN_PLANS' }))
    expect(state.insert).not.toHaveBeenCalled()
  })

  it('rejects PATCH mutation of a legacy unbound launch row', async () => {
    const { PATCH } = await import('@/app/api/setup-decisions/[id]/route')
    const req = new NextRequest('http://localhost/api/setup-decisions/legacy-launch-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actual_launched_value: 'OUTCOME_LEADS', action_taken: true }),
    })

    const res = await PATCH(req, { params: Promise.resolve({ id: 'legacy-launch-1' }) })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'USE_CAMPAIGN_PLANS' }))
  })
})
