import { describe, expect, it, vi } from 'vitest'
import { hashCanonicalDocument, type BusinessContextDocumentV1, type LandingPageSnapshotDocumentV1 } from '@/lib/planning-context/contracts'
import {
  readGovernedPlanningContextReviewForAccount,
  resolveGovernedPlanningContextForAccount,
} from '@/lib/planning-context/resolver'

const ACCOUNT = 'account-a'
const NOW = new Date('2026-07-30T12:00:00.000Z')
const BUSINESS: BusinessContextDocumentV1 = {
  schema_version: 1,
  business: { name: 'Studio', market: 'Springfield', timezone: 'America/New_York', currency: 'USD' },
  offers: [{
    id: 'rental', name: 'Rental', description: 'Private hourly studio rental.',
    kind: 'studio_rental', status: 'active',
    meta_eligibility: 'allowed', booking_url: 'https://example.test/book/',
  }],
  audiences: [],
  approved_claims: [],
  economics: {
    target_cpa: null, max_cpa: null, contribution_margin_percent: null,
    monthly_meta_spend_ceiling: null, basis: null,
  },
  service_area: { status: 'unknown', markets: [], notes: null },
  capacity: { status: 'unknown', weekly_booking_capacity: null, notes: null },
  seasonality: { status: 'unknown', periods: [], notes: null },
  constraints: [],
}
const PAGE: LandingPageSnapshotDocumentV1 = {
  schema_version: 1,
  requested_url: 'https://example.test/book/',
  final_url: 'https://example.test/book/',
  canonical_url: 'https://example.test/book/',
  purpose: 'booking',
  supported_funnel_stages: ['booking'],
  offer_ids: ['rental'],
  claim_ids: [],
  ctas: [{ label: 'Book', kind: 'scheduler', destination: 'https://example.test/book/' }],
  mobile: { status: 'pass', evidence: 'Owner reviewed mobile capture.' },
  runtime: { status: 'pass', http_status: 200, observed_at: NOW.toISOString() },
  tracking: { status: 'observed', inventory: ['GTM'] },
  content_summary: 'Booking scheduler.',
}
const BUSINESS_HASH = hashCanonicalDocument(BUSINESS)
const PAGE_HASH = hashCanonicalDocument(PAGE)

const payload = {
  latest_business_observation: {
    id: 'business-1', ad_account_id: ACCOUNT, revision: 1, schema_version: 1,
    document: BUSINESS, content_hash: BUSINESS_HASH, source_kind: 'owner_entry',
    source_ref: 'owner review', captured_at: NOW.toISOString(), dedupe_key: 'business-v1',
    created_at: NOW.toISOString(),
  },
  latest_business_decision: {
    id: 'business-approval-1', ad_account_id: ACCOUNT, artifact_id: 'business-1',
    artifact_hash: BUSINESS_HASH, decision: 'approved', revision: 1,
    previous_approval_id: null, reviewed_by: 'owner@example.com', reason: 'Reviewed',
    review_due_at: '2026-08-30T00:00:00.000Z', dedupe_key: 'approve-business-v1',
    created_at: NOW.toISOString(),
  },
  approved_business_observation: {
    id: 'business-1', ad_account_id: ACCOUNT, revision: 1, schema_version: 1,
    document: BUSINESS, content_hash: BUSINESS_HASH, source_kind: 'owner_entry',
    source_ref: 'owner review', captured_at: NOW.toISOString(), dedupe_key: 'business-v1',
    created_at: NOW.toISOString(),
  },
  latest_page_observation: {
    id: 'page-1', ad_account_id: ACCOUNT, canonical_url: PAGE.canonical_url,
    requested_url: PAGE.requested_url, final_url: PAGE.final_url,
    revision: 1, schema_version: 1, document: PAGE, content_hash: PAGE_HASH,
    source_kind: 'browser_probe', source_ref: 'owner browser capture',
    captured_at: NOW.toISOString(), dedupe_key: 'page-v1', created_at: NOW.toISOString(),
  },
  latest_page_decision: {
    id: 'page-approval-1', ad_account_id: ACCOUNT, artifact_id: 'page-1', artifact_hash: PAGE_HASH,
    canonical_url: PAGE.canonical_url, business_context_approval_id: 'business-approval-1',
    decision: 'approved', revision: 1, previous_approval_id: null,
    reviewed_by: 'owner@example.com', reason: 'Reviewed',
    review_due_at: '2026-08-30T00:00:00.000Z', dedupe_key: 'approve-page-v1',
    created_at: NOW.toISOString(),
  },
  approved_page_observation: {
    id: 'page-1', ad_account_id: ACCOUNT, canonical_url: PAGE.canonical_url,
    requested_url: PAGE.requested_url, final_url: PAGE.final_url,
    revision: 1, schema_version: 1, document: PAGE, content_hash: PAGE_HASH,
    source_kind: 'browser_probe', source_ref: 'owner browser capture',
    captured_at: NOW.toISOString(), dedupe_key: 'page-v1', created_at: NOW.toISOString(),
  },
}

describe('atomic governed planning-context reader', () => {
  it('uses one exact-account snapshot RPC and no table-by-table read', async () => {
    const rpc = vi.fn(async () => ({ data: payload, error: null }))
    const db = { rpc }

    const out = await resolveGovernedPlanningContextForAccount(
      db as never,
      ACCOUNT,
      'HTTPS://EXAMPLE.TEST:443/book/#fragment',
      NOW,
    )

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('read_governed_planning_context', {
      p_ad_account_id: ACCOUNT,
      p_canonical_url: 'https://example.test/book/',
    })
    expect(out.status).toBe('approved_current')
  })

  it('fails closed on an RPC error or malformed snapshot envelope', async () => {
    const errored = await resolveGovernedPlanningContextForAccount({
      rpc: vi.fn(async () => ({ data: null, error: { message: 'unavailable' } })),
    } as never, ACCOUNT, PAGE.canonical_url, NOW)
    expect(errored.blocker_codes).toEqual(['planning_context_read_failed'])

    const malformed = await resolveGovernedPlanningContextForAccount({
      rpc: vi.fn(async () => ({ data: { latest_business_observation: 'not-a-row' }, error: null })),
    } as never, ACCOUNT, PAGE.canonical_url, NOW)
    expect(malformed.blocker_codes).toEqual(['planning_context_read_failed'])
  })

  it('returns pending owner-review artifacts while withholding them from blocked consumer context', async () => {
    const pendingPayload = {
      ...payload,
      latest_business_decision: null,
      approved_business_observation: null,
      latest_page_decision: null,
      approved_page_observation: null,
    }
    const review = await readGovernedPlanningContextReviewForAccount({
      rpc: vi.fn(async () => ({ data: pendingPayload, error: null })),
    } as never, ACCOUNT, PAGE.canonical_url, NOW)

    expect(review.evaluation).toMatchObject({
      status: 'blocked',
      context_available_for_campaign_plan: false,
      business_context: { document: null },
      landing_page: { document: null },
    })
    expect(review.snapshot?.latest_business_observation?.document).toEqual(BUSINESS)
    expect(review.snapshot?.latest_page_observation?.document).toEqual(PAGE)
    expect(review.snapshot?.latest_business_observation?.source_ref).toBe('owner review')
  })
})
