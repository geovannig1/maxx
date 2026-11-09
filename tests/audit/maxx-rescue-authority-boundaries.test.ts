import '../_support/outcome-noun-booking'
import { withBookingNouns } from '../_support/booking-noun-source'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  adminCalls: vi.fn(),
  setupInsert: vi.fn(async () => 'unexpected-insert'),
  recommendationRead: {
    health: 'healthy',
    recommendations: [],
    visibleCount: 0,
    quarantinedCount: 0,
    reasons: [],
  } as Record<string, unknown>,
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
  getAdminClient: () => {
    state.adminCalls()
    return {
      from: (table: string) => {
        if (table === 'ad_accounts') {
          return {
            select: () => ({
              eq: () => ({
                limit: () => ({
                  then: (
                    resolve: (value: { data: Array<{ id: string; account_id: string; account_name: null }>; error: null }) => unknown,
                    reject?: (reason: unknown) => unknown,
                  ) => Promise.resolve({
                    data: [{ id: 'account-1', account_id: 'act_100000000000091', account_name: null }],
                    error: null,
                  }).then(resolve, reject),
                  maybeSingle: async () => ({
                    data: { id: 'account-1', account_id: 'act_100000000000091' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }

        if (table === 'ad_setup_decisions') {
          const chain: Record<string, unknown> = {}
          chain.select = () => chain
          chain.eq = () => chain
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
          return chain
        }

        throw new Error(`Unexpected database access: ${table}`)
      },
    }
  },
}))

vi.mock('@/lib/recommendations/setup-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recommendations/setup-ledger')>()
  return {
    ...actual,
    insertSetupDecision: state.setupInsert,
    latestDecisionForSetting: vi.fn(async () => null),
  }
})

vi.mock('@/lib/recommendations/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recommendations/store')>()
  return {
    ...actual,
    readOpenRecommendations: vi.fn(async () => state.recommendationRead),
  }
})

import { assessLaunchCohort } from '@/lib/modes/launch-cohort'
import { buildLaunchVerdict } from '@/lib/modes/launch-verdict'
import { defaultManifest } from '@/lib/recommendations/manifest'
import { buildLaunchPerformance } from '@/lib/diagnostics/launch-performance'
import { projectMetaRecommendationDiagnostic } from '@/mcp/tools/diagnosis-bundle'
import { projectMetaRecommendationsForModel } from '@/mcp/tools/meta-recommendations'
import { detectWrongOptimizationEvent } from '@/lib/alerts/detector'
import { processFeedbackForCompletedTests, runFeedbackLoop } from '@/lib/feedback/loop'
import {
  createPausedTestDraft,
} from '@/mcp/tools/write-tools'
import { getOpenRecommendationsTool } from '@/mcp/tools/open-recommendations'

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

const HIGH_STAKES_PLAN_FIELDS = new Set([
  'objective',
  'conversion_event',
  'optimization_event',
  'attribution_window',
  'budget',
  'audience',
  'geo',
  'placements',
  'creative',
  'copy',
  'landing_page',
])

describe('Maxx rescue slice — authority boundaries without a stored CampaignPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.recommendationRead = {
      health: 'healthy',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: 0,
      reasons: [],
    }
  })

  it('keeps every high-stakes setup field structurally blocked and emits no fixed launch setup', () => {
    const rows = defaultManifest('2026-07-30').filter((row) =>
      HIGH_STAKES_PLAN_FIELDS.has(row.setting_category),
    )

    expect(rows.map((row) => row.setting_category).sort()).toEqual([...HIGH_STAKES_PLAN_FIELDS].sort())
    for (const row of rows) {
      expect(row).toMatchObject({
        proposal_status: 'blocked',
        blocker_codes: expect.arrayContaining(['campaign_plan_missing']),
      })
      expect(row.proposed_value).toMatch(/^BLOCKED\b/)
      expect(row.proposed_value).not.toMatch(
        /AppointmentConfirmed|OUTCOME_|OFFSITE_CONVERSIONS|\/book\b|Book Now|\b\d+(?:\.\d+)?\s*(?:mi|miles?|km)\b|\$\s*\d/i,
      )
    }
  })

  it('returns ready=null with CAMPAIGN_PLAN_REQUIRED instead of declaring settings correct or wrong', () => {
    const verdict = buildLaunchVerdict({
      cohort: assessLaunchCohort([]),
      utmAds: [],
      utmCoverageScope: 'plan_cohort_unbound',
      tracking: null,
    })

    expect(verdict.ready).toBeNull()
    expect(verdict.evaluated_cohort).toEqual([])
    expect(verdict.unverified.join(' ')).toMatch(/CAMPAIGN_PLAN_REQUIRED/)

    const launchJudgments = [
      ...verdict.confirmed,
      ...verdict.blockers,
      ...verdict.before_launch,
    ].join('\n')
    expect(launchJudgments).not.toMatch(/(?:correct|wrong).*optimization|switch\s+to\s+AppointmentConfirmed/i)
    expect(launchJudgments).not.toMatch(/(?:use|send|land).*(?:\/book\b|Book Now)|\b\d+\s*(?:mi|miles?|km)\b|\$\s*\d/i)

    const service = read('src/lib/modes/launch-readiness-service.ts')
    expect(service).toMatch(/assessLaunchCohort\(\[\]\)/)
    expect(service).not.toMatch(/designateLaunchCohort\s*\(/)

    const tool = read('src/mcp/tools/launch-readiness.ts')
    expect(tool).toContain("tracking_contract_status: 'unavailable_until_campaign_plan'")
    expect(tool).not.toMatch(/canonical_utm_string|CANONICAL_UTM_STRING/)

    const utmTool = read('src/mcp/tools/utm-health.ts')
    expect(utmTool).toContain("tracking_contract_status: 'unavailable_until_campaign_plan'")
    expect(utmTool).not.toMatch(/canonical_string|paste_instructions|corrected_url_tags|attributed_share recovers/i)
  })

  it('rejects launch_setup POST and legacy launch_setup PATCH at the authenticated API boundary', async () => {
    const { POST } = await import('@/app/api/setup-decisions/route')
    const post = await POST(new NextRequest('http://localhost/api/setup-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'campaign',
        planned_name: 'Unbound launch',
        setting_category: 'objective',
        setting_name: 'Campaign objective',
        proposed_value: 'OUTCOME_LEADS',
        final_value: 'OUTCOME_LEADS',
        origin: 'launch_setup',
        user_decision: 'accepted',
      }),
    }))

    expect(post.status).toBe(409)
    expect(await post.json()).toMatchObject({ code: 'USE_CAMPAIGN_PLANS' })
    expect(state.setupInsert).not.toHaveBeenCalled()

    const { PATCH } = await import('@/app/api/setup-decisions/[id]/route')
    const patch = await PATCH(new NextRequest('http://localhost/api/setup-decisions/legacy-launch-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actual_launched_value: 'OUTCOME_LEADS', action_taken: true }),
    }), { params: Promise.resolve({ id: 'legacy-launch-1' }) })

    expect(patch.status).toBe(409)
    expect(await patch.json()).toMatchObject({ code: 'USE_CAMPAIGN_PLANS' })
  })

  it('keeps the legacy feedback and wrong-optimization cron paths as inert compatibility shims', async () => {
    await expect(runFeedbackLoop('account-1')).resolves.toBe(0)
    await expect(processFeedbackForCompletedTests('account-1')).resolves.toBe(0)
    await expect(detectWrongOptimizationEvent('account-1', '2026-07-30')).resolves.toBe(0)
    expect(state.adminCalls).not.toHaveBeenCalled()
  })

  it('keeps all Meta object creators unavailable and strips caller-selected setup from their output', async () => {
    const arbitrarySetup = {
      approved: 'APPROVED',
      campaign_name: 'Unsafe fixed campaign',
      objective: 'OUTCOME_SALES',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      audience_type: 'warm',
      daily_budget_usd: 999,
      geo_radius_km: 25,
    }

    for (const create of [createPausedTestDraft]) {
      const result = await create(arbitrarySetup)
      const output = JSON.stringify(result)
      expect(result).toMatchObject({
        status: 'NOT_IMPLEMENTED',
        blocker_codes: expect.arrayContaining([
          'experiment_registry_not_implemented',
          'meta_object_creation_not_implemented',
        ]),
      })
      expect(output).not.toMatch(/OUTCOME_SALES|OFFSITE_CONVERSIONS|Unsafe fixed campaign|999|25/)
      expect(output).not.toContain('manual_steps')
    }
  })

  it.each([
    ['image', '@/app/api/generate/image/route'],
    ['video', '@/app/api/generate/video/route'],
  ] as const)('rejects unbound %s generation at the route before any provider or database path', async (_kind, modulePath) => {
    const route = modulePath === '@/app/api/generate/image/route'
      ? await import('@/app/api/generate/image/route')
      : await import('@/app/api/generate/video/route')
    const response = await route.POST(new NextRequest(`http://localhost/api/generate/${_kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Book Now', script: 'Book Now', brief_id: 'unbound' }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'CAMPAIGN_PLAN_NOT_IMPLEMENTED',
      blocker_codes: ['campaign_plan_not_implemented'],
    })
    expect(state.adminCalls).not.toHaveBeenCalled()

    const source = read(`src/app/api/generate/${_kind}/route.ts`)
    expect(source).not.toMatch(/generateAdImage|createUGCVideo|getAdminClient/)
  })

  it('keeps diagnostic producers observational and withholds raw Meta suggestion prose', () => {
    const diagnosis = buildLaunchPerformance({
      today: '2026-07-30',
      adsets: [],
      eventVolume: {
        available: false,
        reason: 'not observed',
        datasetId: null,
        windowDays: 28,
        events: [],
      },
      writeModeEnabled: false,
    })

    expect(diagnosis.prescriptions).toEqual([])
    expect(diagnosis.action_authority).toEqual({
      tier: 'diagnostic_only',
      reason_code: 'diagnostic_observations_only',
    })
    expect(diagnosis.observations.length).toBeGreaterThan(0)
    expect(diagnosis.observations.every((observation) =>
      observation.action_authority_tier === 'diagnostic_only',
    )).toBe(true)
    expect(diagnosis).not.toHaveProperty('levers')
    expect(diagnosis).not.toHaveProperty('recommended_actions')

    const meta = projectMetaRecommendationDiagnostic({
      available: true,
      recommendations: [{
        objectIds: ['adset-1'],
        type: 'BUDGET',
        name: 'Increase budget',
        level: 'AD_SET',
        stage: 'ACTIVE',
        recommendationTime: '2026-07-30T00:00:00Z',
        url: null,
        body: 'Raise budget now.',
        liftEstimate: null,
        opportunityScoreLift: null,
      }],
      groupCount: 1,
      violations: [],
      paging: {
        pagesFollowed: 1,
        cursorFingerprints: [],
        stoppedBecause: 'exhausted',
        complete: true,
        violations: [],
      },
      fetchedAt: '2026-07-30T00:00:00Z',
    })
    expect(meta).toMatchObject({ raw_suggestions_withheld: true, action_authority_tier: 'diagnostic_only' })
    expect(JSON.stringify(meta)).not.toMatch(/Increase budget|Raise budget/i)

    const dedicatedMetaTool = projectMetaRecommendationsForModel({
      available: true,
      recommendations: [{
        objectIds: ['adset-1'],
        type: 'BUDGET',
        name: 'Increase budget',
        level: 'AD_SET',
        stage: 'ACTIVE',
        recommendationTime: '2026-07-30T00:00:00Z',
        url: 'https://business.facebook.com/private-recommendation',
        body: 'Raise budget now.',
        liftEstimate: 0.2,
        opportunityScoreLift: 4,
      }],
      groupCount: 1,
      violations: [],
      paging: {
        pagesFollowed: 1,
        cursorFingerprints: [],
        stoppedBecause: 'exhausted',
        complete: true,
        violations: [],
      },
      fetchedAt: '2026-07-30T00:00:00Z',
    }, Date.parse('2026-07-30T12:00:00Z'))
    expect(dedicatedMetaTool).toMatchObject({
      available: true,
      count: 1,
      raw_suggestions_withheld: true,
      action_authority: { tier: 'diagnostic_only', prescriptions: [] },
    })
    expect(dedicatedMetaTool).not.toHaveProperty('recommendations')
    expect(JSON.stringify(dedicatedMetaTool)).not.toMatch(
      /Increase budget|Raise budget|private-recommendation|\"type\":\"BUDGET\"/i,
    )

    const modelBoundary = [
      read('src/mcp/tools/diagnose-performance.ts'),
      read('src/mcp/tools/diagnosis-bundle.ts'),
      read('src/mcp/instructions.ts'),
    ].join('\n')
    expect(modelBoundary).toMatch(/get_recommendations/)
    expect(modelBoundary).toMatch(/evaluate_recommendation/)
    expect(modelBoundary).not.toMatch(/gate_passed is false[\s\S]{0,220}show it as a labeled TEST/i)
    expect(modelBoundary).toMatch(/A failed gate cannot create a test/i)
    expect(modelBoundary).toMatch(/approved CampaignPlan revision/i)
    expect(modelBoundary).toMatch(/owner ceiling/i)

    const operatingMode = withBookingNouns(read('src/mcp/tools/operating-mode.ts'))
    expect(operatingMode).not.toMatch(/per-campaign ROAS is only valid when attributed_share/i)
    expect(operatingMode).toMatch(/complete exact booking identity/i)
  })

  it('makes degraded current recommendation reads explicit instead of fabricating an empty feed', async () => {
    state.recommendationRead = {
      health: 'degraded',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: 3,
      reasons: [{
        code: 'target_not_current',
        affectedCount: 3,
        message: 'Three stale recommendations were quarantined.',
      }],
    }

    const result = await getOpenRecommendationsTool({}) as Record<string, unknown>
    expect(result).toMatchObject({
      read_health: 'degraded',
      visible_count: 0,
      quarantined_count: 3,
      count: 0,
    })
    expect(result.note).toMatch(/must not infer.*nothing/i)

    for (const file of [
      'src/components/dashboard/dashboard-data.ts',
      'src/lib/decisions/read-model.ts',
      'src/mcp/tools/open-recommendations.ts',
    ]) {
      const source = read(file)
      expect(source, file).toMatch(/\breadOpenRecommendations\b/)
      expect(source, file).not.toMatch(/\bgetOpenRecommendations\s*\(/)
    }
  })
})
