import { describe, expect, it } from 'vitest'
import {
  businessContextDocumentV1Schema,
  hashCanonicalDocument,
  landingPageSnapshotDocumentV1Schema,
  normalizeCanonicalUrl,
  normalizeCtaDestination,
  type BusinessContextDocumentV1,
  type LandingPageSnapshotDocumentV1,
} from '@/lib/planning-context/contracts'
import {
  evaluateGovernedPlanningContext,
  type BusinessContextApprovalRow,
  type BusinessContextVersionRow,
  type LandingPageApprovalRow,
  type LandingPageSnapshotRow,
} from '@/lib/planning-context/resolver'

const NOW = new Date('2026-07-30T12:00:00.000Z')

const businessDocument = (over: Partial<BusinessContextDocumentV1> = {}): BusinessContextDocumentV1 => ({
  schema_version: 1,
  business: {
    name: 'Example Studio',
    market: 'Springfield, Massachusetts',
    timezone: 'America/New_York',
    currency: 'USD',
  },
  offers: [{
    id: 'studio-rental',
    name: 'Studio rental',
    description: 'Private hourly studio rental for photo, video, podcast, and content sessions.',
    kind: 'studio_rental',
    status: 'active',
    meta_eligibility: 'allowed',
    booking_url: 'https://example.test/book/',
  }],
  audiences: [{
    id: 'local-creators',
    name: 'Local creators',
    stage: 'consideration',
    description: 'People evaluating a Springfield studio.',
    offer_ids: ['studio-rental'],
  }],
  approved_claims: [{
    id: 'private-studio', text: 'Private studio rental.', source_ref: 'owner',
    offer_ids: ['studio-rental'],
  }],
  economics: {
    target_cpa: null,
    max_cpa: null,
    contribution_margin_percent: null,
    monthly_meta_spend_ceiling: 1950,
    basis: 'Owner-approved daily ceiling converted to a monthly planning cap.',
  },
  service_area: {
    status: 'known',
    markets: [{
      id: 'springfield', label: 'Springfield, Massachusetts', country_code: 'US', kind: 'city',
      meta_location_key: null, radius_miles: null,
    }],
    notes: 'Eligible market only; a CampaignPlan must still choose exact Meta geo settings.',
  },
  capacity: { status: 'unknown', weekly_booking_capacity: null, notes: null },
  seasonality: { status: 'unknown', periods: [], notes: null },
  constraints: [{ id: 'no-photoshoot-ads', rule: 'Managed photoshoot ads are not approved yet.' }],
  ...over,
})

const pageDocument = (over: Partial<LandingPageSnapshotDocumentV1> = {}): LandingPageSnapshotDocumentV1 => ({
  schema_version: 1,
  requested_url: 'https://example.test/book/',
  final_url: 'https://example.test/book/',
  canonical_url: 'https://example.test/book/',
  purpose: 'booking',
  supported_funnel_stages: ['booking'],
  offer_ids: ['studio-rental'],
  claim_ids: ['private-studio'],
  ctas: [{ label: 'Book now', kind: 'scheduler', destination: 'https://example.test/book/' }],
  mobile: { status: 'pass', evidence: 'Reviewed at the mobile breakpoint.' },
  runtime: { status: 'pass', http_status: 200, observed_at: '2026-07-30T10:00:00.000Z' },
  tracking: { status: 'observed', inventory: ['GTM', 'Meta Pixel', 'Acuity scheduler'] },
  content_summary: 'Direct booking scheduler for visitors ready to choose a date and time.',
  ...over,
})

const BUSINESS_DOC = businessDocument()
const PAGE_DOC = pageDocument()
const BUSINESS_HASH = hashCanonicalDocument(BUSINESS_DOC)
const PAGE_HASH = hashCanonicalDocument(PAGE_DOC)

const businessVersion = (over: Partial<BusinessContextVersionRow> = {}): BusinessContextVersionRow => ({
  id: 'business-version-1',
  ad_account_id: 'account-a',
  schema_version: 1,
  document: BUSINESS_DOC,
  content_hash: BUSINESS_HASH,
  created_at: '2026-07-30T10:00:00.000Z',
  ...over,
})

const businessApproval = (over: Partial<BusinessContextApprovalRow> = {}): BusinessContextApprovalRow => ({
  id: 'business-approval-1',
  ad_account_id: 'account-a',
  artifact_id: 'business-version-1',
  artifact_hash: BUSINESS_HASH,
  decision: 'approved',
  revision: 1,
  review_due_at: '2026-10-30T00:00:00.000Z',
  ...over,
})

const pageSnapshot = (over: Partial<LandingPageSnapshotRow> = {}): LandingPageSnapshotRow => ({
  id: 'page-snapshot-1',
  ad_account_id: 'account-a',
  requested_url: 'https://example.test/book/',
  final_url: 'https://example.test/book/',
  canonical_url: 'https://example.test/book/',
  schema_version: 1,
  document: PAGE_DOC,
  content_hash: PAGE_HASH,
  created_at: '2026-07-30T10:00:00.000Z',
  ...over,
})

const pageApproval = (over: Partial<LandingPageApprovalRow> = {}): LandingPageApprovalRow => ({
  id: 'page-approval-1',
  ad_account_id: 'account-a',
  artifact_id: 'page-snapshot-1',
  artifact_hash: PAGE_HASH,
  canonical_url: 'https://example.test/book/',
  business_context_approval_id: 'business-approval-1',
  decision: 'approved',
  revision: 1,
  review_due_at: '2026-08-30T00:00:00.000Z',
  ...over,
})

function approvedInput() {
  return {
    now: NOW,
    adAccountId: 'account-a',
    requestedLandingPageUrl: 'https://example.test/book/',
    latestBusinessObservation: businessVersion(),
    latestBusinessDecision: businessApproval(),
    approvedBusinessObservation: businessVersion(),
    latestPageObservation: pageSnapshot(),
    latestPageDecision: pageApproval(),
    approvedPageObservation: pageSnapshot(),
  }
}

describe('governed planning-context documents', () => {
  it('hashes canonical JSON rather than object insertion order', () => {
    expect(hashCanonicalDocument({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(hashCanonicalDocument({ a: { c: 3, d: 4 }, b: 2 }))
    expect(BUSINESS_HASH).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('normalizes an exact HTTP(S) page identity and rejects non-web schemes', () => {
    expect(normalizeCanonicalUrl('HTTPS://Example.Test:443/book#top')).toBe('https://example.test/book')
    expect(normalizeCanonicalUrl('https://example.test')).toBe('https://example.test/')
    expect(() => normalizeCanonicalUrl('javascript:alert(1)')).toThrow(/HTTP/i)
    expect(() => normalizeCanonicalUrl('https://user:secret@example.test/book')).toThrow(/credentials/i)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      offers: [{
        id: 'studio-rental', name: 'Studio rental',
        description: 'Private hourly studio rental.', kind: 'studio_rental', status: 'active',
        meta_eligibility: 'allowed', booking_url: 'https://user:secret@example.test/book',
      }],
    })).success).toBe(false)
    const oversizedUrl = `https://example.test/book/?q=${'x'.repeat(2050)}`
    expect(() => normalizeCanonicalUrl(oversizedUrl)).toThrow(/too long/i)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      requested_url: oversizedUrl,
    })).success).toBe(false)
  })

  it('rejects free-text contact data, secrets, and oversized documents', () => {
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      approved_claims: [{
        id: 'public-contact', text: 'Email studio@example.com for the studio.', source_ref: 'owner',
        offer_ids: ['studio-rental'],
      }],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      content_summary: 'A visitor entered 555-555-0123 while booking.',
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      approved_claims: [{
        id: 'secret', text: 'api_key=do-not-store-this', source_ref: 'owner',
        offer_ids: ['studio-rental'],
      }],
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      offers: [{
        ...BUSINESS_DOC.offers[0],
        booking_url: 'https://example.test/book/?access_token=secret-value',
      }],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      content_summary: 'Captured https://files.example.test/a?X-Amz-Signature=credential-value during review.',
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      constraints: [{
        id: 'secret-material',
        rule: 'Diagnostic export contained -----BEGIN PRIVATE KEY----- and must never be retained.',
      }],
    })).success).toBe(false)

    const largeOffers = Array.from({ length: 8 }, (_, index) => ({
      ...BUSINESS_DOC.offers[0],
      id: `offer-${index}`,
      name: `Offer ${index}`,
      description: `${index}:${'x'.repeat(3500)}`,
    }))
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      offers: largeOffers,
      audiences: [],
      approved_claims: [],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      tracking: {
        status: 'observed',
        inventory: Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(1000)}`),
      },
    })).success).toBe(false)
  })

  it('requires explicit unknown economics and rejects an inverted CPA policy', () => {
    expect(businessContextDocumentV1Schema.safeParse(BUSINESS_DOC).success).toBe(true)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      economics: {
        target_cpa: 170,
        max_cpa: 85,
        contribution_margin_percent: null,
        monthly_meta_spend_ceiling: null,
        basis: null,
      },
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      economics: {
        target_cpa: 52,
        max_cpa: 85,
        contribution_margin_percent: null,
        monthly_meta_spend_ceiling: null,
        basis: null,
      },
    })).success).toBe(false)
  })

  it('binds each governed claim to known offers and requires an offer description', () => {
    const scoped = {
      ...BUSINESS_DOC,
      offers: BUSINESS_DOC.offers.map((offer) => ({
        ...offer,
        description: 'Private hourly studio rental for photo, video, podcast, and content sessions.',
      })),
      approved_claims: BUSINESS_DOC.approved_claims.map((claim) => ({
        ...claim,
        offer_ids: ['studio-rental'],
      })),
    }
    expect(businessContextDocumentV1Schema.safeParse(scoped).success).toBe(true)
    expect(businessContextDocumentV1Schema.safeParse({
      ...scoped,
      approved_claims: [{
        ...scoped.approved_claims[0],
        offer_ids: ['not-a-real-offer'],
      }],
    }).success).toBe(false)
  })

  it('requires explicit service-area and seasonality states without inventing geo or dates', () => {
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      service_area: { status: 'unknown', markets: [], notes: null },
      seasonality: { status: 'none', periods: [], notes: 'No seasonal constraint is currently approved.' },
    })).success).toBe(true)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      service_area: { status: 'unknown', markets: [{
        id: 'guessed-radius', label: 'Guessed radius', country_code: 'US', kind: 'radius',
        meta_location_key: null, radius_miles: 25,
      }], notes: null },
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      seasonality: {
        status: 'known', notes: null,
        periods: [{
          id: 'invalid-period', label: 'Invalid', start_date: '2026-12-31',
          end_date: '2026-12-01', offer_ids: ['studio-rental'],
        }],
      },
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      service_area: { status: 'known', markets: [{
        id: 'incomplete-radius', label: 'Incomplete radius', country_code: 'US', kind: 'radius',
        meta_location_key: null, radius_miles: null,
      }], notes: null },
    })).success).toBe(false)
    expect(businessContextDocumentV1Schema.safeParse(businessDocument({
      service_area: { status: 'known', markets: [{
        id: 'city-with-radius', label: 'Springfield', country_code: 'US', kind: 'city',
        meta_location_key: null, radius_miles: 25,
      }], notes: null },
    })).success).toBe(false)
  })

  it('requires page purpose, mobile/runtime evidence, and an exact canonical URL', () => {
    expect(landingPageSnapshotDocumentV1Schema.safeParse(PAGE_DOC).success).toBe(true)
    expect(landingPageSnapshotDocumentV1Schema.safeParse({
      ...PAGE_DOC,
      canonical_url: 'not-a-url',
    }).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse({
      ...PAGE_DOC,
      mobile: { status: 'pass', evidence: null },
      runtime: { status: 'pass', http_status: null, observed_at: null },
    }).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      runtime: { status: 'pass', http_status: 500, observed_at: '2026-07-30T10:00:00.000Z' },
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      runtime: { status: 'pass', http_status: 200, observed_at: '2099-07-30T10:00:00.000Z' },
    })).success).toBe(true)
  })

  it('represents structured web, phone, and email CTA destinations without accepting executable or ambiguous schemes', () => {
    expect(normalizeCtaDestination('phone', 'tel:(555) 555-0123')).toBe('tel:5555550123')
    expect(normalizeCtaDestination('phone', 'tel:+1 (555) 555-0123')).toBe('tel:+15555550123')
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      ctas: [
        { label: 'Book', kind: 'scheduler', destination: 'https://example.test/book/' },
        { label: 'Call', kind: 'phone', destination: 'tel:+15555550123' },
        { label: 'Local call', kind: 'phone', destination: 'tel:(555) 555-0123' },
        { label: 'Email', kind: 'email', destination: 'mailto:studio@example.com' },
      ],
    })).success).toBe(true)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      ctas: [{ label: 'Unsafe', kind: 'navigate', destination: 'javascript:alert(1)' }],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      ctas: [{ label: 'Local phone', kind: 'phone', destination: 'tel:5555550123' }],
    })).success).toBe(true)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      ctas: [{ label: 'Too short', kind: 'phone', destination: 'tel:555123' }],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse({
      ...PAGE_DOC,
      ctas: [{ label: 'Phone without destination', kind: 'phone', destination: null }],
    }).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      ctas: [{ label: 'Email with tracking query', kind: 'email', destination: 'mailto:studio@example.com?subject=Lead' }],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      ctas: [{ label: 'Wrong kind', kind: 'scheduler', destination: 'mailto:studio@example.com' }],
    })).success).toBe(false)
    expect(landingPageSnapshotDocumentV1Schema.safeParse(pageDocument({
      content_summary: 'Customer contact 5555550123 asked for a callback.',
    })).success).toBe(false)
  })
})

describe('governed planning-context evaluation', () => {
  it('fails closed when observations are missing and never emits campaign settings', () => {
    const out = evaluateGovernedPlanningContext({
      now: NOW,
      adAccountId: 'account-a',
      requestedLandingPageUrl: 'https://example.test/book/',
      latestBusinessObservation: null,
      latestBusinessDecision: null,
      approvedBusinessObservation: null,
      latestPageObservation: null,
      latestPageDecision: null,
      approvedPageObservation: null,
    })
    expect(out.status).toBe('blocked')
    expect(out.blocker_codes).toEqual([
      'business_context_missing',
      'landing_page_snapshot_missing',
    ])
    expect(out).not.toHaveProperty('recommended_settings')
  })

  it('distinguishes unapproved observations from missing facts', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessDecision: null,
      approvedBusinessObservation: null,
      latestPageDecision: null,
      approvedPageObservation: null,
    })
    expect(out.blocker_codes).toEqual([
      'business_context_unapproved',
      'landing_page_snapshot_unapproved',
    ])
  })

  it('uses the owner review deadline instead of an inferred age threshold', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessDecision: businessApproval({ review_due_at: '2026-07-30T11:59:59.000Z' }),
      latestPageDecision: pageApproval({ review_due_at: '2026-07-30T11:59:59.000Z' }),
    })
    expect(out.blocker_codes).toEqual([
      'business_context_review_expired',
      'landing_page_review_expired',
    ])
  })

  it('blocks a stored-document digest mismatch', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      approvedBusinessObservation: businessVersion({ content_hash: `sha256:${'0'.repeat(64)}` }),
      approvedPageObservation: pageSnapshot({ content_hash: `sha256:${'1'.repeat(64)}` }),
    })
    expect(out.blocker_codes).toEqual([
      'business_context_integrity_mismatch',
      'landing_page_integrity_mismatch',
    ])
  })

  it('verifies the newest observations instead of trusting their stored hashes', () => {
    const changedBusiness = businessDocument({
      constraints: [{ id: 'changed', rule: 'Changed while carrying a forged prior digest.' }],
    })
    const changedPage = pageDocument({ content_summary: 'Changed while carrying a forged prior digest.' })
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessObservation: businessVersion({
        id: 'business-version-2',
        document: changedBusiness,
        content_hash: BUSINESS_HASH,
      }),
      latestPageObservation: pageSnapshot({
        id: 'page-snapshot-2',
        document: changedPage,
        content_hash: PAGE_HASH,
      }),
    })
    expect(out.blocker_codes).toEqual([
      'business_context_integrity_mismatch',
      'landing_page_integrity_mismatch',
    ])
  })

  it('fails closed instead of throwing on corrupt stored URL identity', () => {
    expect(() => evaluateGovernedPlanningContext({
      ...approvedInput(),
      approvedPageObservation: pageSnapshot({ canonical_url: 'not-a-url' }),
    })).not.toThrow()
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      approvedPageObservation: pageSnapshot({ canonical_url: 'not-a-url' }),
    })
    expect(out.blocker_codes).toContain('landing_page_integrity_mismatch')
  })

  it('binds requested and final URL evidence to the immutable page row', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      approvedPageObservation: pageSnapshot({ final_url: 'https://example.test/other/' }),
    })
    expect(out.blocker_codes).toContain('landing_page_integrity_mismatch')
  })

  it('fails closed when any returned row belongs to another account', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessObservation: businessVersion({ ad_account_id: 'account-b' }),
    })
    expect(out.blocker_codes).toEqual(['planning_context_account_mismatch'])
    expect(out.context_available_for_campaign_plan).toBe(false)
  })

  it('blocks a newer different observation but not a same-content recapture', () => {
    const changedBusiness = businessDocument({
      constraints: [{ id: 'changed', rule: 'A newly observed rule awaiting owner review.' }],
    })
    const changedPage = pageDocument({ content_summary: 'Changed page content awaiting review.' })
    const changed = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessObservation: businessVersion({
        id: 'business-version-2',
        document: changedBusiness,
        content_hash: hashCanonicalDocument(changedBusiness),
        created_at: '2026-07-30T11:00:00.000Z',
      }),
      latestPageObservation: pageSnapshot({
        id: 'page-snapshot-2',
        document: changedPage,
        content_hash: hashCanonicalDocument(changedPage),
        created_at: '2026-07-30T11:00:00.000Z',
      }),
    })
    expect(changed.blocker_codes).toEqual([
      'business_context_newer_unapproved',
      'landing_page_newer_unapproved',
    ])

    const same = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessObservation: businessVersion({ id: 'business-version-2' }),
      latestPageObservation: pageSnapshot({ id: 'page-snapshot-2' }),
    })
    expect(same.status).toBe('approved_current')
  })

  it('does not trust a newer observation that reuses an old digest for changed content', () => {
    const changedBusiness = businessDocument({
      constraints: [{ id: 'unhashed-change', rule: 'Changed without a matching digest.' }],
    })
    const changedPage = pageDocument({ content_summary: 'Changed without a matching digest.' })
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessObservation: businessVersion({
        id: 'business-version-poisoned',
        document: changedBusiness,
        content_hash: BUSINESS_HASH,
      }),
      latestPageObservation: pageSnapshot({
        id: 'page-snapshot-poisoned',
        document: changedPage,
        content_hash: PAGE_HASH,
      }),
    })
    expect(out.blocker_codes).toEqual([
      'business_context_integrity_mismatch',
      'landing_page_integrity_mismatch',
    ])
  })

  it('requires an exact page URL instead of selecting an arbitrary account page', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      requestedLandingPageUrl: null,
      latestPageObservation: null,
      latestPageDecision: null,
      approvedPageObservation: null,
    })
    expect(out.landing_page.status).toBe('url_required')
    expect(out.blocker_codes).toContain('landing_page_url_required')
  })

  it('blocks a page approved against a superseded business decision', () => {
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessDecision: businessApproval({ id: 'business-approval-2', revision: 2 }),
    })
    expect(out.landing_page.status).toBe('business_context_conflict')
    expect(out.blocker_codes).toContain('landing_page_business_context_conflict')
  })

  it('blocks page claims and offers that the approved business context does not define', () => {
    const page = pageDocument({
      offer_ids: ['unknown-offer'],
      claim_ids: ['unknown-claim'],
    })
    const pageHash = hashCanonicalDocument(page)
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestPageObservation: pageSnapshot({ document: page, content_hash: pageHash }),
      approvedPageObservation: pageSnapshot({ document: page, content_hash: pageHash }),
      latestPageDecision: pageApproval({ artifact_hash: pageHash }),
    })
    expect(out.blocker_codes).toContain('landing_page_business_context_conflict')
  })

  it('blocks a page claim that is approved only for a different offer', () => {
    const scopedBusiness = businessDocument({
      offers: [
        ...BUSINESS_DOC.offers,
        {
          id: 'managed-shoot', name: 'Managed shoot', description: 'Managed photoshoot service.',
          kind: 'managed_photoshoot', status: 'paused', meta_eligibility: 'blocked',
          booking_url: null,
        },
      ],
      approved_claims: [{
        id: 'managed-only', text: 'A managed shoot claim.', source_ref: 'owner',
        offer_ids: ['managed-shoot'],
      }],
    })
    const scopedHash = hashCanonicalDocument(scopedBusiness)
    const page = pageDocument({ claim_ids: ['managed-only'], offer_ids: ['studio-rental'] })
    const pageHash = hashCanonicalDocument(page)
    const out = evaluateGovernedPlanningContext({
      ...approvedInput(),
      latestBusinessObservation: businessVersion({ document: scopedBusiness, content_hash: scopedHash }),
      approvedBusinessObservation: businessVersion({ document: scopedBusiness, content_hash: scopedHash }),
      latestBusinessDecision: businessApproval({ artifact_hash: scopedHash }),
      latestPageObservation: pageSnapshot({ document: page, content_hash: pageHash }),
      approvedPageObservation: pageSnapshot({ document: page, content_hash: pageHash }),
      latestPageDecision: pageApproval({ artifact_hash: pageHash }),
    })
    expect(out.blocker_codes).toContain('landing_page_business_context_conflict')
  })

  it('treats a read failure as authoritative even when cached rows look complete', () => {
    const out = evaluateGovernedPlanningContext({ ...approvedInput(), readError: true })
    expect(out.status).toBe('blocked')
    expect(out.blocker_codes).toEqual(['planning_context_read_failed'])
    expect(out.business_context.status).toBe('read_failed')
    expect(out.landing_page.status).toBe('read_failed')
  })

  it('makes approved inputs available for planning without authorizing a launch or settings', () => {
    const out = evaluateGovernedPlanningContext(approvedInput())
    expect(out).toMatchObject({
      status: 'approved_current',
      context_available_for_campaign_plan: true,
      blocker_codes: [],
      business_context: { status: 'approved_current', approval_id: 'business-approval-1' },
      landing_page: { status: 'approved_current', approval_id: 'page-approval-1' },
    })
    expect(out).not.toHaveProperty('ready')
    expect(out).not.toHaveProperty('recommended_settings')
  })
})
