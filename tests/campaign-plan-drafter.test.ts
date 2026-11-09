import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanDraftContext } from '@/lib/campaigns/plan-template'

// ADR-062: drafting. The template planner is deterministic; the AI planner's proposal is untrusted and
// normalised (budget and objective never come from the model; unknown ids are dropped; ad sets are
// consolidated for small budgets). The gateway and the copy generator are MOCKED: no provider, no cost.

const state = vi.hoisted(() => ({
  ai: 'on' as 'on' | 'off',
  answer: null as unknown,
  error: null as unknown,
  calls: [] as Array<Record<string, unknown>>,
  copy: null as unknown,
}))

vi.mock('@/lib/ai', async () => {
  const errors = await vi.importActual<typeof import('@/lib/ai/errors')>('@/lib/ai/errors')
  return {
    ...errors,
    aiStatus: () => (state.ai === 'on' ? { state: 'on', provider: 'anthropic', family: 'anthropic', model: 'test-model' } : { state: 'off', inferred: true }),
    generateStructured: vi.fn(async (request: Record<string, unknown>) => {
      state.calls.push(request)
      if (state.error) throw state.error
      return { text: '', value: state.answer, provider: 'anthropic', family: 'anthropic', model: 'test-model', usage: { inputTokens: 1, outputTokens: 1 } }
    }),
  }
})
vi.mock('@/lib/creative/copy-generator', () => ({
  generateCopy: vi.fn(async () => state.copy),
}))

const { buildTemplatePlan, maxAdSetsFor } = await import('@/lib/campaigns/plan-template')
const { proposePlanWithAi, normalizeAiProposal } = await import('@/lib/campaigns/plan-ai')
const { planBriefSchema } = await import('@/lib/campaigns/plan-brief')

const COPY = (angle: string, text: string) => ({ primary_text: text, headline: `Headline ${angle}`, description: '', cta: 'BOOK_NOW' as const, angle: angle as never })

function ctx(over: Partial<PlanDraftContext> = {}): PlanDraftContext {
  return {
    currency: 'USD', today: '2026-11-08', pixelId: '111', pageId: '555', outcomeEvent: 'Purchase',
    landingHosts: ['studio.example'], defaultDestination: 'https://studio.example/book',
    audiences: [
      { id: '900', name: 'Website visitors 30d', subtype: 'WEBSITE', approximateCount: 4000, metaAccountId: 'act_1' },
      { id: '901', name: 'Customer list', subtype: 'CUSTOM', approximateCount: 2500, metaAccountId: 'act_1' },
    ],
    assets: [1, 2, 3, 4].map((n) => ({ ref: `A${n}`, creativeId: `70${n}`, name: `Creative ${n}`, imageHash: `hash00${n}`, videoId: null, thumbnailUrl: null, linkUrl: 'https://studio.example/', urlTags: null })),
    copyBank: [COPY('offer', 'Book a bright studio by the hour.'), COPY('specific_benefit', 'Natural window light all day.'), COPY('problem_solution', 'No room at home? Rent ours.')],
    toMinor: (major) => Math.round(major * 100),
    minDailyMinor: (goal) => (goal === 'OFFSITE_CONVERSIONS' ? 500 : 100),
    ...over,
  }
}

const brief = (over: Record<string, unknown> = {}) => planBriefSchema.parse({
  goal: 'sales', product: 'Studio rental', offer: 'First hour free', daily_budget: 30, audience_description: 'Local product photographers',
  countries: ['US'], start_date: '2026-11-10', ...over,
})

beforeEach(() => { state.ai = 'on'; state.answer = null; state.error = null; state.calls = []; state.copy = null })

describe('template planner (AI off)', () => {
  it('builds one consolidated CBO campaign with an Advantage+ ad set and paired copy and visuals', () => {
    const { spec, notes } = buildTemplatePlan(brief(), ctx())
    expect(spec.campaign).toMatchObject({ objective: 'OUTCOME_SALES', budget_mode: 'CBO', daily_budget_minor: 3000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null })
    expect(spec.conversion).toEqual({ pixel_id: '111', custom_event: 'Purchase' })
    expect(spec.ad_sets).toHaveLength(1)
    expect(spec.ad_sets[0]).toMatchObject({ optimization_goal: 'OFFSITE_CONVERSIONS', daily_budget_minor: null, placements: 'advantage_plus', audience: { mode: 'advantage_plus', countries: ['US'] } })
    expect(spec.ad_sets[0].ads.map((a) => [a.creative, a.copy?.angle])).toEqual([
      [{ mode: 'image', image_hash: 'hash001' }, 'offer'], [{ mode: 'image', image_hash: 'hash002' }, 'specific_benefit'], [{ mode: 'image', image_hash: 'hash003' }, 'problem_solution'],
    ])
    expect(spec.ad_sets[0].ads.every((a) => a.destination_url === 'https://studio.example/book' && a.url_tags.includes('meta_ad_id={{ad.id}}'))).toBe(true)
    expect(notes).toEqual([])
  })

  it('adds a warm ad set only when the budget can carry it', () => {
    expect(maxAdSetsFor(3000, 500)).toBe(1)
    expect(maxAdSetsFor(6000, 500)).toBe(2)
    expect(maxAdSetsFor(20000, 500)).toBe(3)
    const { spec } = buildTemplatePlan(brief({ daily_budget: 80 }), ctx())
    expect(spec.ad_sets.map((s) => s.audience.mode)).toEqual(['advantage_plus', 'custom'])
    expect(spec.ad_sets[1].audience.custom_audience_ids).toEqual(['900'])
    expect(spec.ad_sets[0].audience.excluded_audience_ids).toEqual(['900'])
  })

  it('without a pixel optimises for landing-page views and says why', () => {
    const { spec, notes } = buildTemplatePlan(brief(), ctx({ pixelId: null }))
    expect(spec.conversion).toBeNull()
    expect(spec.ad_sets[0].optimization_goal).toBe('LANDING_PAGE_VIEWS')
    expect(notes.join(' ')).toMatch(/No pixel/)
  })

  it('with no saved copy reuses existing creatives as they are and says so', () => {
    const { spec, notes } = buildTemplatePlan(brief(), ctx({ copyBank: [] }))
    expect(spec.ad_sets[0].ads.every((a) => a.creative.mode === 'existing_creative' && a.copy === null)).toBe(true)
    expect(notes.join(' ')).toMatch(/Copy studio/)
  })

  it('traffic goals never ask for a pixel', () => {
    const { spec } = buildTemplatePlan(brief({ goal: 'traffic' }), ctx())
    expect(spec.campaign.objective).toBe('OUTCOME_TRAFFIC')
    expect(spec.conversion).toBeNull()
    expect(spec.ad_sets[0].optimization_goal).toBe('LANDING_PAGE_VIEWS')
  })
})

describe('AI planner (mocked gateway)', () => {
  const proposal = {
    campaign_name: 'Studio launch',
    rationale: 'Prospect broad, retarget warm.',
    ad_sets: [
      { name: 'Prospecting', audience_mode: 'advantage_plus', custom_audience_ids: [], excluded_audience_ids: ['900', 'forged-1'], age_min: 21, age_max: 60, creative_refs: ['A1', 'A2', 'A9'] },
      { name: 'Warm', audience_mode: 'custom', custom_audience_ids: ['900'], excluded_audience_ids: [], age_min: 18, age_max: 65, creative_refs: ['A3'] },
      { name: 'Third', audience_mode: 'custom', custom_audience_ids: ['not-mine'], excluded_audience_ids: [], age_min: 18, age_max: 65, creative_refs: [] },
    ],
    daily_budget: 9999, objective: 'OUTCOME_AWARENESS', status: 'ACTIVE',
  }

  it('normalises an untrusted proposal: budget and objective from the brief, consolidation, unknown ids dropped', () => {
    const { spec, notes } = normalizeAiProposal(proposal, brief(), ctx(), ctx().copyBank)
    expect(spec.campaign).toMatchObject({ name: 'Studio launch', objective: 'OUTCOME_SALES', daily_budget_minor: 3000 })
    expect(spec.ad_sets).toHaveLength(1)
    expect(spec.ad_sets[0].audience).toMatchObject({ mode: 'advantage_plus', excluded_audience_ids: ['900'], age_min: 21, age_max: 60 })
    expect(spec.ad_sets[0].ads.map((a) => a.creative)).toEqual([{ mode: 'image', image_hash: 'hash001' }, { mode: 'image', image_hash: 'hash002' }, { mode: 'image', image_hash: 'hash003' }])
    expect(JSON.stringify(spec)).not.toMatch(/ACTIVE|9999|OUTCOME_AWARENESS|forged-1/)
    expect(notes.join(' ')).toMatch(/consolidated/i)
  })

  it('a custom ad set whose audiences are all unknown falls back to Advantage+', () => {
    const { spec } = normalizeAiProposal({ ...proposal, ad_sets: [proposal.ad_sets[2]] }, brief(), ctx(), ctx().copyBank)
    expect(spec.ad_sets[0].audience).toMatchObject({ mode: 'advantage_plus', custom_audience_ids: [] })
  })

  it('sends only ids and names to the model, then uses generated copy that passed the scorer', async () => {
    state.answer = proposal
    state.copy = {
      status: 'ok', rejected: [], grounding: {}, model: { provider: 'anthropic', model: 'test-model' },
      variants: [
        { ...COPY('offer', 'Rent the studio by the hour.'), hook: 'h', rationale: '', score: { score: 90, publishable: true, findings: [] }, status: 'ready' },
        { ...COPY('ugc', 'Best studio in the world, guaranteed.'), hook: 'h', rationale: '', score: { score: 40, publishable: false, findings: [] }, status: 'blocked' },
      ],
    }
    const result = await proposePlanWithAi(brief(), ctx())
    expect(result.source).toBe('ai')
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].feature).toBe('campaign_planning')
    const prompt = String(state.calls[0].user)
    expect(prompt).toContain('A1')
    expect(prompt).toContain('900')
    expect(prompt).not.toMatch(/hash001/)
    const angles = result.spec.ad_sets[0].ads.map((a) => a.copy?.primary_text)
    expect(angles).toContain('Rent the studio by the hour.')
    expect(angles).not.toContain('Best studio in the world, guaranteed.')
  })

  it('falls back to the template, with a note, when the model fails', async () => {
    const { AiRefusalError } = await import('@/lib/ai/errors')
    state.error = new AiRefusalError(null)
    const result = await proposePlanWithAi(brief(), ctx())
    expect(result.source).toBe('template')
    expect(result.notes.join(' ')).toMatch(/template/i)
  })

  it('with AI off makes no model call at all', async () => {
    state.ai = 'off'
    const result = await proposePlanWithAi(brief(), ctx())
    expect(result.source).toBe('template')
    expect(state.calls).toHaveLength(0)
  })
})
