import { describe, expect, it } from 'vitest'

import type {
  PaidCreativeDirection,
  PaidCreativeEvidence,
  PaidCreativeOutcomes,
} from '@/lib/creative/paid-outcomes'
import { projectVisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes'

const RUN = '00000000-0000-4000-8000-000000000931'
const RECENT = '00000000-0000-4000-8000-000000000932'
const MATURED = '00000000-0000-4000-8000-000000000933'

function evidence(
  metaCreativeId: string,
  generationId: string,
  spend: number,
  bookings: number,
  bookedValue: number,
): PaidCreativeEvidence {
  return {
    status: 'available',
    complete: true,
    evaluation_run_id: RUN,
    generation_id: generationId,
    meta_creative_id: metaCreativeId,
    creative_name: `Creative ${metaCreativeId}`,
    thumbnail_url: null,
    contributing_meta_ad_ids: [`ad-${metaCreativeId}`],
    assignment_observation_ids: [`before-${metaCreativeId}`, `after-${metaCreativeId}`],
    blocker_codes: [],
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    outcomes: {
      spend,
      landing_page_views: 5,
      captured_touches: bookings,
      value_bearing_bookings: bookings,
      booked_value: bookedValue,
      zero_value_bookings: 0,
      canceled_links: 0,
    },
  }
}

function direction(
  cohortKind: 'recent_scale' | 'matured_cut',
  creatives: PaidCreativeEvidence[],
): PaidCreativeDirection {
  return {
    status: 'available',
    generation_id: cohortKind === 'recent_scale' ? RECENT : MATURED,
    cohort_kind: cohortKind,
    window_start: cohortKind === 'recent_scale' ? '2026-07-16' : '2026-07-02',
    window_end: cohortKind === 'recent_scale' ? '2026-07-29' : '2026-07-15',
    as_of_date: '2026-07-30',
    contract_version: 1,
    policy_version: 1,
    blocker_codes: [],
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    creatives,
  }
}

function paidOutcomes(): PaidCreativeOutcomes {
  return {
    status: 'available',
    evaluation_run_id: RUN,
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    note: 'Governed paid creative evidence.',
    recent_scale: direction('recent_scale', [
      evidence('501', RECENT, 10, 1, 100),
      evidence('502', RECENT, 20, 0, 0),
    ]),
    matured_cut: direction('matured_cut', [evidence('501', MATURED, 30, 2, 200)]),
  }
}

function observation(
  metaCreativeId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `version-${metaCreativeId}`,
    meta_creative_id: metaCreativeId,
    analysis_schema_version: 2,
    prompt_version: 'creative-attributes-v2',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    source_asset_fingerprint: `sha256:${'a'.repeat(64)}`,
    prompt_fingerprint: `sha256:${'b'.repeat(64)}`,
    analysis_fingerprint: `sha256:${'c'.repeat(64)}`,
    analyzed_at: '2026-08-12T12:00:00.000Z',
    analysis: {
      format: metaCreativeId === '501' ? 'video' : 'static',
      has_text_overlay: metaCreativeId === '501',
      hook_text: 'must never become a grouping field',
      shows_price: false,
      talent_type: metaCreativeId === '501' ? 'solo' : 'none',
      setting: 'studio',
      color_mood: metaCreativeId === '501' ? 'bright' : 'dark',
      cta_visible: metaCreativeId === '501',
      hook_strength_score: 5,
      notes: 'must never become a grouping field',
    },
    ...overrides,
  }
}

/** The analysis identity these fixtures were written with (the configured family and model). */
const IDENTITY = { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' }

type Projected = ReturnType<typeof projectVisionPaidAttributeOutcomes>
type DirectionProjection = NonNullable<Projected['recent_scale']>
type Group = DirectionProjection['groups'][number]

function group(
  projected: Projected,
  directionName: 'recent_scale' | 'matured_cut',
  attribute: string,
  value: string,
): Group | undefined {
  return projected[directionName]?.groups.find(
    (candidate) => candidate.attribute === attribute && candidate.value === value,
  )
}

describe('versioned vision paid-outcome attribute distributions', () => {
  it('groups only whitelisted attributes and keeps the two governed directions separate', () => {
    const projected = projectVisionPaidAttributeOutcomes(
      paidOutcomes(),
      [observation('501'), observation('502')],
      IDENTITY,
    )

    expect(projected).toMatchObject({
      status: 'available',
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      non_additive: true,
      recent_scale: {
        status: 'available',
        generation_id: RECENT,
        missing_versioned_vision_count: 0,
        blocker_codes: [],
      },
      matured_cut: {
        status: 'available',
        generation_id: MATURED,
        missing_versioned_vision_count: 0,
        blocker_codes: [],
      },
    })
    expect(group(projected, 'recent_scale', 'format', 'video')).toMatchObject({
      creative_count: 1,
      sparse: true,
      outcomes: { spend: 10, value_bearing_bookings: 1, booked_value: 100 },
    })
    expect(group(projected, 'recent_scale', 'format', 'static')).toMatchObject({
      creative_count: 1,
      sparse: true,
      outcomes: { spend: 20, value_bearing_bookings: 0, booked_value: 0 },
    })
    expect(group(projected, 'matured_cut', 'format', 'video')).toMatchObject({
      creative_count: 1,
      sparse: true,
      outcomes: { spend: 30, value_bearing_bookings: 2, booked_value: 200 },
    })

    const attributes = new Set(projected.recent_scale?.groups.map(({ attribute }) => attribute))
    expect(attributes).toEqual(new Set([
      'format',
      'has_text_overlay',
      'shows_price',
      'talent_type',
      'setting',
      'color_mood',
      'cta_visible',
    ]))
    expect(JSON.stringify(projected)).not.toMatch(/hook_text|hook_strength_score|notes/i)
  })

  it('declares non-additivity and never publishes derived or prescriptive claims', () => {
    const projected = projectVisionPaidAttributeOutcomes(
      paidOutcomes(),
      [observation('501'), observation('502')],
      IDENTITY,
    )
    const serialized = JSON.stringify(projected)

    expect(projected.non_additive).toBe(true)
    expect(projected.action_authority_tier).toBe('diagnostic_only')
    expect(projected.prescriptions).toEqual([])
    expect(serialized).not.toMatch(/cpa|roas|caus(?:al|ed)|ranking|winner|loser|budget/i)
    expect(projected.recent_scale?.groups.every((candidate) => candidate.sparse)).toBe(true)
  })

  it('excludes missing or incomplete versions with an explicit count and blocker', () => {
    const incompleteVersion = observation('502', { prompt_fingerprint: null })
    const projected = projectVisionPaidAttributeOutcomes(
      paidOutcomes(),
      [observation('501'), incompleteVersion],
      IDENTITY,
    )

    expect(projected.recent_scale).toMatchObject({
      status: 'available',
      missing_versioned_vision_count: 1,
      blocker_codes: ['versioned_vision_missing'],
    })
    expect(projected.recent_scale?.groups.every((candidate) => (
      candidate.creative_count === 1
      && candidate.outcomes.spend === 10
      && candidate.outcomes.booked_value === 100
    ))).toBe(true)
    expect(projected.matured_cut).toMatchObject({
      status: 'available',
      missing_versioned_vision_count: 0,
      blocker_codes: [],
    })
  })

  it('admits only observations from the configured model, and none with AI off', () => {
    // Control: the same two observations are admitted under their own identity.
    const own = projectVisionPaidAttributeOutcomes(paidOutcomes(), [observation('501'), observation('502')], IDENTITY)
    expect(own.recent_scale?.missing_versioned_vision_count).toBe(0)

    const otherModel = projectVisionPaidAttributeOutcomes(
      paidOutcomes(), [observation('501'), observation('502')], { provider: 'anthropic', model: 'claude-opus-5-5' },
    )
    expect(otherModel.recent_scale).toMatchObject({ missing_versioned_vision_count: 2, groups: [] })

    const aiOff = projectVisionPaidAttributeOutcomes(paidOutcomes(), [observation('501'), observation('502')], null)
    expect(aiOff.recent_scale).toMatchObject({ missing_versioned_vision_count: 2, groups: [] })
  })

  it('publishes no groups for a blocked governed paid direction', () => {
    const paid = paidOutcomes()
    paid.recent_scale = {
      status: 'blocked',
      generation_id: RECENT,
      cohort_kind: 'recent_scale',
      window_start: '2026-07-16',
      window_end: '2026-07-29',
      as_of_date: '2026-07-30',
      contract_version: 1,
      policy_version: 1,
      blocker_codes: ['paid_capture_incomplete'],
      action_authority_tier: 'diagnostic_only',
      prescriptions: [],
      creatives: [],
    }

    const projected = projectVisionPaidAttributeOutcomes(paid, [observation('501')], IDENTITY)

    expect(projected.recent_scale).toEqual(expect.objectContaining({
      status: 'blocked',
      blocker_codes: ['paid_capture_incomplete'],
      groups: [],
    }))
    expect(projected.matured_cut?.groups.length).toBeGreaterThan(0)
  })
})
