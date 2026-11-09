import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import type { PaidCreativeOutcomes } from '@/lib/creative/paid-outcomes'
import {
  computeVisionAnalysisFingerprint,
  computeVisionPromptFingerprint,
  computeVisionSourceAssetFingerprint,
} from '@/lib/creative/vision-analyzer'
import type { VisionAnalysis } from '@/lib/creative/vision-analyzer'
import { readVisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes-store'

const ACCOUNT = '00000000-0000-4000-8000-000000000941'
const CREATIVE_ROW = '00000000-0000-4000-8000-000000000942'
const VERSION = '00000000-0000-4000-8000-000000000943'
const GENERATION = '00000000-0000-4000-8000-000000000944'
const RUN = '00000000-0000-4000-8000-000000000945'
const MATURED = '00000000-0000-4000-8000-000000000950'

const creative = {
  id: CREATIVE_ROW,
  ad_account_id: ACCOUNT,
  creative_id: '1000000000000007',
  thumbnail_url: 'https://cdn.example/942.jpg',
  image_url: null,
  image_hash: 'image-942',
  video_id: null,
  body: 'Studio rental',
  title: 'Create here',
  asset_type: 'VIDEO',
  child_attachments: null,
  object_story_spec: null,
  asset_feed_spec: null,
}

const analysis: VisionAnalysis = {
  format: 'video', has_text_overlay: true, hook_text: null, shows_price: false,
  talent_type: 'solo', setting: 'studio', color_mood: 'bright', cta_visible: true,
  hook_strength_score: 3, notes: null,
}

const paid: PaidCreativeOutcomes = {
  status: 'available', evaluation_run_id: RUN, action_authority_tier: 'diagnostic_only',
  prescriptions: [], note: 'Governed evidence.',
  matured_cut: {
    status: 'blocked', generation_id: MATURED, cohort_kind: 'matured_cut',
    window_start: '2026-07-02', window_end: '2026-07-15', as_of_date: '2026-07-30',
    contract_version: 1, policy_version: 1, blocker_codes: ['paid_capture_incomplete'],
    action_authority_tier: 'diagnostic_only', prescriptions: [], creatives: [],
  },
  recent_scale: {
    status: 'available', generation_id: GENERATION, cohort_kind: 'recent_scale',
    window_start: '2026-07-16', window_end: '2026-07-29', as_of_date: '2026-07-30',
    contract_version: 1, policy_version: 1, blocker_codes: [],
    action_authority_tier: 'diagnostic_only', prescriptions: [],
    creatives: [{
      status: 'available', complete: true, evaluation_run_id: RUN, generation_id: GENERATION,
      meta_creative_id: creative.creative_id, creative_name: null, thumbnail_url: null,
      contributing_meta_ad_ids: ['1000000000000003'],
      assignment_observation_ids: [
        '00000000-0000-4000-8000-000000000946',
        '00000000-0000-4000-8000-000000000947',
      ],
      blocker_codes: [], action_authority_tier: 'diagnostic_only', prescriptions: [],
      outcomes: {
        spend: 25, landing_page_views: 5, captured_touches: 2,
        value_bearing_bookings: 1, booked_value: 125,
        zero_value_bookings: 0, canceled_links: 0,
      },
    }],
  },
}

type Row = Record<string, unknown>

function version(overrides: Row = {}): Row {
  const analyzerInput = { ...creative, object_type: creative.asset_type }
  return {
    id: VERSION,
    ad_account_id: ACCOUNT,
    creative_id: CREATIVE_ROW,
    meta_creative_id: creative.creative_id,
    analysis_schema_version: 2,
    prompt_version: 'creative-attributes-v2',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    source_asset_fingerprint: computeVisionSourceAssetFingerprint(analyzerInput),
    prompt_fingerprint: computeVisionPromptFingerprint(analyzerInput),
    analysis_fingerprint: computeVisionAnalysisFingerprint(analysis),
    analysis,
    analyzed_at: '2026-08-12T12:00:00.000Z',
    ...overrides,
  }
}

function fakeDb(tables: Record<string, Row[]>, failingTable?: string) {
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = []
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    const query = { table, filters: {} as Record<string, unknown> }
    queries.push(query)
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      query.filters[column] = value
      rows = rows.filter((row) => row[column] === value)
      return chain
    })
    chain.in = vi.fn((column: string, values: unknown[]) => {
      query.filters[column] = values
      rows = rows.filter((row) => values.includes(row[column]))
      return chain
    })
    chain.order = vi.fn(() => chain)
    chain.range = vi.fn(() => chain)
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(
      failingTable === table
        ? { data: null, error: { message: `${table} unavailable` } }
        : { data: rows, error: null },
    ).then(resolve)
    return chain
  })
  return { db: { from } as unknown as SupabaseClient, queries }
}

/** The analysis identity these fixtures were written with (the configured family and model). */
const IDENTITY = { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' }

describe('readVisionPaidAttributeOutcomes', () => {
  it('reads account-scoped current source and only projects its matching immutable version', async () => {
    const other = { ...version(), id: '00000000-0000-4000-8000-000000000948', ad_account_id: '00000000-0000-4000-8000-000000000949' }
    const { db, queries } = fakeDb({
      creatives: [creative, { ...creative, ad_account_id: other.ad_account_id }],
      creative_vision_analysis_versions: [version(), other],
    })

    const result = await readVisionPaidAttributeOutcomes(db, ACCOUNT, paid, IDENTITY)

    expect(result.status).toBe('available')
    expect(result.recent_scale?.missing_versioned_vision_count).toBe(0)
    expect(result.recent_scale?.groups).toContainEqual(expect.objectContaining({
      attribute: 'format', value: 'video', outcomes: expect.objectContaining({ booked_value: 125 }),
    }))
    expect(queries.every(({ filters }) => filters.ad_account_id === ACCOUNT)).toBe(true)
  })

  it('withholds a stale source version instead of describing it as current', async () => {
    const { db } = fakeDb({
      creatives: [creative],
      creative_vision_analysis_versions: [version({ source_asset_fingerprint: `sha256:${'d'.repeat(64)}` })],
    })

    const result = await readVisionPaidAttributeOutcomes(db, ACCOUNT, paid, IDENTITY)

    expect(result).toMatchObject({
      status: 'blocked',
      recent_scale: {
        status: 'blocked',
        missing_versioned_vision_count: 1,
        blocker_codes: ['versioned_vision_missing'],
        groups: [],
      },
    })
  })

  it('reads only the configured model\'s versions, and nothing with AI off', async () => {
    const tables = { creatives: [creative], creative_vision_analysis_versions: [version()] }
    // Control: the same rows are read under their own identity.
    expect((await readVisionPaidAttributeOutcomes(fakeDb(tables).db, ACCOUNT, paid, IDENTITY)).status).toBe('available')

    const otherModel = fakeDb(tables)
    const other = await readVisionPaidAttributeOutcomes(otherModel.db, ACCOUNT, paid, { provider: 'openai', model: 'local-vision-1' })
    expect(other.recent_scale).toMatchObject({ missing_versioned_vision_count: 1, groups: [] })
    expect(otherModel.queries.some(({ filters }) => filters.model === 'local-vision-1')).toBe(true)

    const off = fakeDb(tables)
    const aiOff = await readVisionPaidAttributeOutcomes(off.db, ACCOUNT, paid, null)
    expect(aiOff.recent_scale).toMatchObject({ missing_versioned_vision_count: 1, groups: [] })
    expect(off.queries).toHaveLength(0)
  })

  it('validates account identity and reports source read errors with typed codes', async () => {
    const invalid = fakeDb({})
    await expect(readVisionPaidAttributeOutcomes(invalid.db, 'not-a-uuid', paid, IDENTITY))
      .rejects.toMatchObject({ code: 'INPUT_INVALID' })
    expect(invalid.queries).toHaveLength(0)

    const failed = fakeDb({ creatives: [] }, 'creatives')
    await expect(readVisionPaidAttributeOutcomes(failed.db, ACCOUNT, paid, IDENTITY))
      .rejects.toMatchObject({ code: 'SOURCE_READ_FAILED' })
  })
})
