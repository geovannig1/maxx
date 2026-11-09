import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GovernedPlanningContext } from '@/lib/planning-context/resolver'
import type {
  BusinessContextDocumentV1,
  LandingPageSnapshotDocumentV1,
} from '@/lib/planning-context/contracts'

const state = vi.hoisted(() => ({
  db: { kind: 'admin-client' },
  planning: null as GovernedPlanningContext | null,
  resolveContext: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.db }))
vi.mock('@/lib/planning-context/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning-context/resolver')>()
  return { ...actual, resolveGovernedPlanningContextForAccount: state.resolveContext }
})
vi.mock('@/lib/tracking/health-monitor', () => ({
  checkTrackingHealth: vi.fn(async () => ({
    pixel_id: 'pixel-1', status: 'healthy', dormant: false, issues: [],
  })),
}))

const blockedContext = (): GovernedPlanningContext => ({
  status: 'blocked',
  context_available_for_campaign_plan: false,
  blocker_codes: ['business_context_missing', 'landing_page_url_required'],
  business_context: {
    status: 'missing', version_id: null, approval_id: null, content_hash: null, document: null,
  },
  landing_page: {
    status: 'url_required', canonical_url: null, snapshot_id: null, approval_id: null,
    content_hash: null, document: null,
  },
})

const businessDocument: BusinessContextDocumentV1 = {
  schema_version: 1,
  business: { name: 'Studio', market: 'Springfield', timezone: 'America/New_York', currency: 'USD' },
  offers: [{
    id: 'rental', name: 'Rental', description: 'Private hourly studio rental.',
    kind: 'studio_rental', status: 'active',
    meta_eligibility: 'allowed', booking_url: 'https://example.test/book/',
  }],
  audiences: [], approved_claims: [],
  economics: {
    target_cpa: null, max_cpa: null, contribution_margin_percent: null,
    monthly_meta_spend_ceiling: null, basis: null,
  },
  service_area: { status: 'unknown', markets: [], notes: null },
  capacity: { status: 'unknown', weekly_booking_capacity: null, notes: null },
  seasonality: { status: 'unknown', periods: [], notes: null },
  constraints: [],
}
const pageDocument: LandingPageSnapshotDocumentV1 = {
  schema_version: 1,
  requested_url: 'https://example.test/book/',
  final_url: 'https://example.test/book/',
  canonical_url: 'https://example.test/book/',
  purpose: 'booking', supported_funnel_stages: ['booking'], offer_ids: ['rental'], claim_ids: [],
  ctas: [{ label: 'Book', kind: 'scheduler', destination: 'https://example.test/book/' }],
  mobile: { status: 'pass', evidence: 'Owner reviewed.' },
  runtime: { status: 'pass', http_status: 200, observed_at: '2026-07-30T12:00:00.000Z' },
  tracking: { status: 'observed', inventory: ['GTM'] },
  content_summary: 'Booking page.',
}

const approvedContext = (): GovernedPlanningContext => ({
  status: 'approved_current',
  context_available_for_campaign_plan: true,
  blocker_codes: [],
  business_context: {
    status: 'approved_current', version_id: 'business-v1', approval_id: 'business-a1',
    content_hash: `sha256:${'a'.repeat(64)}`, document: businessDocument,
  },
  landing_page: {
    status: 'approved_current', canonical_url: 'https://example.test/book/',
    snapshot_id: 'page-v1', approval_id: 'page-a1', content_hash: `sha256:${'b'.repeat(64)}`,
    document: pageDocument,
  },
})

describe('launch readiness consumes governed planning context', () => {
  beforeEach(() => {
    state.resolveContext.mockReset()
    state.resolveContext.mockImplementation(async () => state.planning ?? blockedContext())
  })

  it('passes the exact account and requested URL to the governed resolver and surfaces stable blockers', async () => {
    state.planning = blockedContext()
    const { resolveLaunchReadiness } = await import('@/lib/modes/launch-readiness-service')
    const result = await resolveLaunchReadiness('account-db-id', {
      skipTracking: true,
      landingPageUrl: 'https://example.test/book/',
    })

    expect(state.resolveContext).toHaveBeenCalledWith(
      state.db,
      'account-db-id',
      'https://example.test/book/',
    )
    expect(result.planningContext).toEqual(state.planning)
    expect(result.verdict.ready).toBeNull()
    expect(result.verdict.unverified.join(' ')).toMatch(/CAMPAIGN_CONTEXT_REQUIRED/)
    expect(result.verdict.unverified.join(' ')).toMatch(/business_context_missing/)
  })

  it('approved context is confirmed but cannot bypass the immutable CampaignPlan requirement', async () => {
    state.planning = approvedContext()
    const { resolveLaunchReadiness } = await import('@/lib/modes/launch-readiness-service')
    const result = await resolveLaunchReadiness('account-db-id', {
      skipTracking: true,
      landingPageUrl: 'https://example.test/book/',
    })

    expect(result.planningContext?.status).toBe('approved_current')
    expect(result.verdict.confirmed.join(' ')).toMatch(/business context business-v1/i)
    expect(result.verdict.confirmed.join(' ')).toMatch(/landing-page snapshot page-v1/i)
    expect(result.verdict.unverified.join(' ')).toMatch(/CAMPAIGN_PLAN_REQUIRED/)
    expect(result.verdict.ready).toBeNull()
  })

  it('lets non-planning callers skip the context RPC instead of fabricating a missing-page result', async () => {
    state.planning = approvedContext()
    const { resolveLaunchReadiness } = await import('@/lib/modes/launch-readiness-service')
    const result = await resolveLaunchReadiness('account-db-id', {
      skipTracking: true,
      skipPlanningContext: true,
    })

    expect(state.resolveContext).not.toHaveBeenCalled()
    expect(result.planningContext).toBeNull()
    expect(result.verdict.unverified.join(' ')).toMatch(/CAMPAIGN_CONTEXT_NOT_EVALUATED/)
  })
})
