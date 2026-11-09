import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GovernedPlanningContext } from '@/lib/planning-context/resolver'

const state = vi.hoisted(() => ({
  resolveLaunchReadiness: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ kind: 'admin' }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: { id: 'account-db-id', accountId: 'act_1', accountName: 'Studio' },
  })),
  activeAccountErrorCode: vi.fn(),
}))
vi.mock('@/lib/modes/launch-readiness-service', () => ({
  resolveLaunchReadiness: state.resolveLaunchReadiness,
}))

const approvedContext = (): GovernedPlanningContext => ({
  status: 'approved_current',
  context_available_for_campaign_plan: true,
  blocker_codes: [],
  business_context: {
    status: 'approved_current',
    version_id: 'business-v1',
    approval_id: 'business-a1',
    content_hash: `sha256:${'a'.repeat(64)}`,
    document: {
      schema_version: 1,
      business: { name: 'Private studio name', market: 'Springfield', timezone: 'America/New_York', currency: 'USD' },
      offers: [{
        id: 'rental', name: 'Rental', description: 'Private hourly studio rental.',
        kind: 'studio_rental', status: 'active',
        meta_eligibility: 'allowed', booking_url: 'https://example.test/book/',
      }],
      audiences: [],
      approved_claims: [{
        id: 'private-claim', text: 'Private approved copy', source_ref: 'owner', offer_ids: ['rental'],
      }],
      economics: {
        target_cpa: null, max_cpa: null, contribution_margin_percent: null,
        monthly_meta_spend_ceiling: null, basis: null,
      },
      service_area: { status: 'unknown', markets: [], notes: null },
      capacity: { status: 'unknown', weekly_booking_capacity: null, notes: null },
      seasonality: { status: 'unknown', periods: [], notes: null },
      constraints: [],
    },
  },
  landing_page: {
    status: 'approved_current',
    canonical_url: 'https://example.test/book/',
    snapshot_id: 'page-v1',
    approval_id: 'page-a1',
    content_hash: `sha256:${'b'.repeat(64)}`,
    document: {
      schema_version: 1,
      requested_url: 'https://example.test/book/',
      final_url: 'https://example.test/book/',
      canonical_url: 'https://example.test/book/',
      purpose: 'booking',
      supported_funnel_stages: ['booking'],
      offer_ids: ['rental'],
      claim_ids: [],
      ctas: [{ label: 'Book', kind: 'scheduler', destination: 'https://example.test/book/' }],
      mobile: { status: 'pass', evidence: 'Owner reviewed.' },
      runtime: { status: 'pass', http_status: 200, observed_at: '2026-07-30T12:00:00.000Z' },
      tracking: { status: 'observed', inventory: ['GTM'] },
      content_summary: 'Private page summary.',
    },
  },
})

describe('get_launch_readiness planning-context projection', () => {
  beforeEach(() => {
    state.resolveLaunchReadiness.mockReset()
    state.resolveLaunchReadiness.mockResolvedValue({
      verdict: {
        ready: null,
        evaluated_cohort: { status: 'unverified' },
        source_of_truth: [], confirmed: [], unverified: [], blockers: [],
        historical_cleanup: [], before_launch: [], after_launch: [],
      },
      utm: { scope: 'none', coverage: null, adsUnverified: 0, source_label: 'none' },
      tracking: null,
      planningContext: approvedContext(),
    })
  })

  it('passes only the exact requested landing-page URL into the account-scoped service', async () => {
    const { getLaunchReadiness } = await import('@/mcp/tools/launch-readiness')
    await getLaunchReadiness({ landing_page_url: 'https://example.test/book/' })

    expect(state.resolveLaunchReadiness).toHaveBeenCalledWith('account-db-id', {
      landingPageUrl: 'https://example.test/book/',
    })
  })

  it('returns the stable fail-closed envelope when readiness resolution throws', async () => {
    state.resolveLaunchReadiness.mockRejectedValueOnce(new Error('database unavailable'))
    const { getLaunchReadiness } = await import('@/mcp/tools/launch-readiness')
    const result = await getLaunchReadiness({ landing_page_url: 'https://example.test/book/' })

    expect(result).toMatchObject({
      ready: null,
      ready_label: 'unverified',
      error_code: 'LAUNCH_READINESS_UNAVAILABLE',
      campaign_settings_authorized: false,
      meta_write_performed: false,
    })
  })

  it('rejects malformed or oversized landing-page input before resolving private context', async () => {
    const { getLaunchReadiness } = await import('@/mcp/tools/launch-readiness')
    const wrongType = await getLaunchReadiness({ landing_page_url: 42 } as unknown as {
      landing_page_url: string
    })
    const oversized = await getLaunchReadiness({
      landing_page_url: `https://example.test/${'x'.repeat(5000)}`,
    })

    expect(wrongType).toMatchObject({ error_code: 'LANDING_PAGE_URL_INVALID' })
    expect(oversized).toMatchObject({ error_code: 'LANDING_PAGE_URL_INVALID' })
    expect(state.resolveLaunchReadiness).not.toHaveBeenCalled()
  })

  it('returns approved-current status and lineage without exposing governed documents', async () => {
    const { getLaunchReadiness } = await import('@/mcp/tools/launch-readiness')
    const result = await getLaunchReadiness({ landing_page_url: 'https://example.test/book/' })

    expect(result).toMatchObject({
      planning_context_status: 'approved_current',
      planning_context_available: true,
      planning_context_blockers: [],
      business_context: {
        status: 'approved_current', version_id: 'business-v1', approval_id: 'business-a1',
      },
      landing_page_context: {
        status: 'approved_current', canonical_url: 'https://example.test/book/',
        snapshot_id: 'page-v1', approval_id: 'page-a1',
      },
      campaign_settings_authorized: false,
      meta_write_performed: false,
    })
    expect(result).not.toHaveProperty('planning_context_input')
    expect(JSON.stringify(result)).not.toContain('Private approved copy')
    expect(JSON.stringify(result)).not.toContain('Private page summary')
  })

  it('withholds documents when governed context is not approved-current', async () => {
    const approved = approvedContext()
    state.resolveLaunchReadiness.mockResolvedValueOnce({
      verdict: {
        ready: null,
        evaluated_cohort: { status: 'unverified' },
        source_of_truth: [], confirmed: [], unverified: [], blockers: [],
        historical_cleanup: [], before_launch: [], after_launch: [],
      },
      utm: { scope: 'none', coverage: null, adsUnverified: 0, source_label: 'none' },
      tracking: null,
      planningContext: {
        ...approved,
        status: 'blocked',
        context_available_for_campaign_plan: false,
        blocker_codes: ['business_context_review_expired'],
        business_context: { ...approved.business_context, status: 'review_expired', document: null },
        landing_page: { ...approved.landing_page, status: 'business_context_conflict', document: null },
      },
    })

    const { getLaunchReadiness } = await import('@/mcp/tools/launch-readiness')
    const result = await getLaunchReadiness({ landing_page_url: 'https://example.test/book/' })

    expect(result).toMatchObject({
      planning_context_available: false,
      campaign_settings_authorized: false,
      meta_write_performed: false,
    })
    expect(result).not.toHaveProperty('planning_context_input')
    expect(JSON.stringify(result)).not.toContain('Private approved copy')
    expect(JSON.stringify(result)).not.toContain('Private page summary')
  })

  it('keeps the architecture record aligned with the status-only MCP boundary', async () => {
    const fs = await import('node:fs')
    for (const file of [
      'docs/architecture/adr-055-governed-business-page-context.md',
    ]) {
      const record = fs.readFileSync(file, 'utf8')
      expect(record, file).not.toMatch(/campaign_plan_input_only/i)
      expect(record, file).toMatch(/never (?:returns|exposes) the approved documents/i)
    }
  })
})
