import { describe, expect, it, vi } from 'vitest'
import {
  executePlanningContextCommand,
  planningContextCommandSchema,
  type PlanningContextCommand,
} from '@/lib/planning-context/store'
import { hashCanonicalDocument, type BusinessContextDocumentV1 } from '@/lib/planning-context/contracts'

const ACCOUNT = '00000000-0000-4000-8000-000000000001'
const BUSINESS: BusinessContextDocumentV1 = {
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

function rpcDb(data: unknown = { id: 'row-1' }) {
  const rpc = vi.fn<(
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: null }>>().mockResolvedValue({ data, error: null })
  return { db: { rpc }, rpc }
}

describe('planning-context governed command store', () => {
  it('rejects sensitive provenance and owner-reason text at the command boundary', () => {
    expect(planningContextCommandSchema.safeParse({
      action: 'commit_business', document: BUSINESS, source_kind: 'admin_import',
      source_ref: 'https://files.example.test/context?X-Amz-Signature=credential-value',
      captured_at: '2026-07-30T10:00:00.000Z', dedupe_key: 'sensitive-source',
    }).success).toBe(false)
    expect(planningContextCommandSchema.safeParse({
      action: 'withdraw_business',
      expected_current_approval_id: '00000000-0000-4000-8000-000000000010',
      reason: 'Customer client@example.com requested this change.',
      dedupe_key: 'sensitive-reason',
    }).success).toBe(false)
    expect(planningContextCommandSchema.safeParse({
      action: 'withdraw_business',
      expected_current_approval_id: '00000000-0000-4000-8000-000000000010',
      reason: 'Customer 3055550123 requested this change.',
      dedupe_key: 'sensitive-compact-phone',
    }).success).toBe(false)
  })

  it('computes the business digest server-side and never accepts an account from the command', async () => {
    const { db, rpc } = rpcDb()
    const command: PlanningContextCommand = {
      action: 'commit_business',
      document: BUSINESS,
      source_kind: 'owner_entry',
      source_ref: 'owner-reviewed fixture',
      captured_at: '2026-07-30T10:00:00.000Z',
      dedupe_key: 'business-v1',
    }

    await executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', command)

    expect(rpc).toHaveBeenCalledWith('commit_business_context_version', expect.objectContaining({
      p_ad_account_id: ACCOUNT,
      p_content_hash: hashCanonicalDocument(BUSINESS),
      p_document: BUSINESS,
      p_dedupe_key: 'business-v1',
    }))
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('p_account_from_body')
  })

  it('maps the database active-account guard to a stable conflict', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: 'governed context requires the sole active ad account' },
    }))
    const db = { rpc }

    await expect(executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', {
      action: 'commit_business',
      document: BUSINESS,
      source_kind: 'owner_entry',
      source_ref: 'owner-reviewed fixture',
      captured_at: '2026-07-30T10:00:00.000Z',
      dedupe_key: 'business-inactive-account',
    })).rejects.toMatchObject({
      code: 'CONTEXT_ACTIVE_ACCOUNT_CHANGED',
      status: 409,
    })
  })

  it('normalizes every page URL before hashing and committing', async () => {
    const { db, rpc } = rpcDb()
    await executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', {
      action: 'commit_page',
      document: {
        schema_version: 1,
        requested_url: 'HTTPS://EXAMPLE.TEST:443/book/#top',
        final_url: 'https://example.test/book/',
        canonical_url: 'https://example.test/book/#fragment',
        purpose: 'booking', supported_funnel_stages: ['booking'], offer_ids: ['rental'], claim_ids: [],
        ctas: [{ label: 'Book', kind: 'scheduler', destination: 'https://example.test/book/#form' }],
        mobile: { status: 'pass', evidence: 'Reviewed.' },
        runtime: { status: 'pass', http_status: 200, observed_at: '2026-07-30T10:00:00.000Z' },
        tracking: { status: 'observed', inventory: ['GTM'] },
        content_summary: 'Booking page.',
      },
      source_kind: 'browser_probe', source_ref: 'owner browser capture',
      captured_at: '2026-07-30T10:00:00.000Z', dedupe_key: 'page-v1',
    })

    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>
    expect(args).toMatchObject({
      p_requested_url: 'https://example.test/book/',
      p_final_url: 'https://example.test/book/',
      p_canonical_url: 'https://example.test/book/',
    })
    const document = args.p_document as { canonical_url: string; ctas: Array<{ destination: string }> }
    expect(document.canonical_url).toBe('https://example.test/book/')
    expect(document.ctas[0].destination).toBe('https://example.test/book/')
    expect(args.p_content_hash).toBe(hashCanonicalDocument(document))
  })

  it('rejects page runtime evidence observed after its declared capture time', async () => {
    const { db, rpc } = rpcDb()
    await expect(executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', {
      action: 'commit_page',
      document: {
        schema_version: 1,
        requested_url: 'https://example.test/book/',
        final_url: 'https://example.test/book/',
        canonical_url: 'https://example.test/book/',
        purpose: 'booking', supported_funnel_stages: ['booking'], offer_ids: ['rental'], claim_ids: [],
        ctas: [{ label: 'Book', kind: 'scheduler', destination: 'https://example.test/book/' }],
        mobile: { status: 'pass', evidence: 'Reviewed.' },
        runtime: { status: 'pass', http_status: 200, observed_at: '2026-07-30T10:01:00.000Z' },
        tracking: { status: 'observed', inventory: ['GTM'] },
        content_summary: 'Booking page.',
      },
      source_kind: 'browser_probe', source_ref: 'owner browser capture',
      captured_at: '2026-07-30T10:00:00.000Z', dedupe_key: 'page-bad-timeline',
    })).rejects.toMatchObject({ code: 'CONTEXT_INPUT_REJECTED' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('recomputes an artifact digest before approval and blocks corrupted storage', async () => {
    const artifact = {
      id: '00000000-0000-4000-8000-000000000010',
      ad_account_id: ACCOUNT,
      schema_version: 1,
      document: BUSINESS,
      content_hash: `sha256:${'0'.repeat(64)}`,
    }
    const maybeSingle = vi.fn(async () => ({ data: artifact, error: null }))
    const builder = { select: () => builder, eq: () => builder, maybeSingle }
    const rpc = vi.fn()
    const db = { from: vi.fn(() => builder), rpc }

    await expect(executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', {
      action: 'approve_business',
      artifact_id: artifact.id,
      expected_previous_approval_id: null,
      reason: 'Owner reviewed.',
      review_due_at: '2026-10-30T00:00:00.000Z',
      dedupe_key: 'approve-v1',
    })).rejects.toMatchObject({ code: 'CONTEXT_INTEGRITY_MISMATCH' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('derives approval actor and exact artifact hash before calling the RPC', async () => {
    const artifact = {
      id: '00000000-0000-4000-8000-000000000010',
      ad_account_id: ACCOUNT,
      schema_version: 1,
      document: BUSINESS,
      content_hash: hashCanonicalDocument(BUSINESS),
    }
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: vi.fn(async () => ({ data: artifact, error: null })),
    }
    const rpc = vi.fn(async () => ({ data: { id: 'approval-1' }, error: null }))
    const db = { from: vi.fn(() => builder), rpc }

    await executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', {
      action: 'approve_business', artifact_id: artifact.id, expected_previous_approval_id: null,
      reason: 'Owner reviewed.', review_due_at: '2026-10-30T00:00:00.000Z', dedupe_key: 'approve-v1',
    })
    expect(rpc).toHaveBeenCalledWith('approve_business_context_version', expect.objectContaining({
      p_ad_account_id: ACCOUNT,
      p_expected_hash: artifact.content_hash,
      p_reviewed_by: 'owner@example.com',
    }))
  })

  it('blocks page approval when stored requested/final URL identity differs from the document', async () => {
    const document = {
      schema_version: 1 as const,
      requested_url: 'https://example.test/book/',
      final_url: 'https://example.test/book/',
      canonical_url: 'https://example.test/book/',
      purpose: 'booking' as const,
      supported_funnel_stages: ['booking' as const],
      offer_ids: ['rental'], claim_ids: [],
      ctas: [{ label: 'Book', kind: 'scheduler' as const, destination: 'https://example.test/book/' }],
      mobile: { status: 'pass' as const, evidence: 'Reviewed.' },
      runtime: { status: 'pass' as const, http_status: 200, observed_at: '2026-07-30T10:00:00.000Z' },
      tracking: { status: 'observed' as const, inventory: ['GTM'] },
      content_summary: 'Booking page.',
    }
    const artifact = {
      id: '00000000-0000-4000-8000-000000000011', ad_account_id: ACCOUNT,
      requested_url: 'https://attacker.test/book/', final_url: document.final_url,
      canonical_url: document.canonical_url, schema_version: 1,
      document, content_hash: hashCanonicalDocument(document),
    }
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: vi.fn(async () => ({ data: artifact, error: null })),
    }
    const rpc = vi.fn()
    const db = { from: vi.fn(() => builder), rpc }

    await expect(executePlanningContextCommand(db as never, ACCOUNT, 'owner@example.com', {
      action: 'approve_page', artifact_id: artifact.id,
      business_context_approval_id: '00000000-0000-4000-8000-000000000020',
      expected_previous_approval_id: null, reason: 'Owner reviewed.',
      review_due_at: '2026-10-30T00:00:00.000Z', dedupe_key: 'approve-page-v1',
    })).rejects.toMatchObject({ code: 'CONTEXT_INTEGRITY_MISMATCH' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
