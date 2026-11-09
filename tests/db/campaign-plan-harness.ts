// Shared harness for the campaign-plan executor DB tests (ADR-062): a FAKE Meta (no network) the
// registry mock hands to the creator, a sound plan spec, and a helper that drafts, submits and approves
// a plan through the shipped RPCs. Test files keep their own vi.mock calls (they must be hoisted there).
import { expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { campaignPlanSpecSchema, PAID_TOUCH_URL_TAGS, type CampaignPlanSpec } from '@/lib/campaigns/plan-spec'

export interface FakeObject { id: string; edge: string; body: Record<string, string> }
export interface FakeMeta {
  objects: FakeObject[]
  creates: Array<{ edge: string; body: Record<string, string> }>
  statusCalls: Array<{ id: string; status: string }>
  failOnCreate: null | ((edge: string, n: number) => boolean)
  readOverride: null | ((id: string) => Record<string, unknown> | null | undefined)
  /** Replaces the marker lookup (e.g. to make Meta answer with an object this request never made). */
  findOverride: null | ((edge: string, marker: string) => { ok: true; id: string | null } | { ok: false })
  next: number
}

export const emptyMeta = (): FakeMeta => ({ objects: [], creates: [], statusCalls: [], failOnCreate: null, readOverride: null, findOverride: null, next: 9000 })

/** The platform registry module, with Meta replaced by the fake. */
export function fakeRegistry(meta: FakeMeta) {
  const units = { supports: () => true, toMinor: (n: number) => Math.round(n * 100), fromMinor: (n: number) => n / 100 }
  const campaignCreation = {
    isConfigured: () => true,
    create: async (edge: string, body: Record<string, string>) => {
      meta.creates.push({ edge, body })
      if (meta.failOnCreate?.(edge, meta.creates.length)) return { ok: false, error: { code: 'META_REJECTED', message: 'Invalid parameter' } }
      const id = String(meta.next++)
      meta.objects.push({ id, edge, body: { ...body } })
      return { ok: true, id }
    },
    findMarked: async (edge: string, marker: string) => {
      if (meta.findOverride) return meta.findOverride(edge, marker)
      const hits = meta.objects.filter((o) => o.body.name?.includes(`[${marker}]`))
      return { ok: true, id: hits[0]?.id ?? null }
    },
    read: async (id: string) => {
      if (meta.readOverride) { const r = meta.readOverride(id); if (r !== undefined) return r }
      const o = meta.objects.find((x) => x.id === id)
      return o ? { id, name: o.body.name, status: o.body.status ?? null, daily_budget: o.body.daily_budget ?? null } : null
    },
    setStatus: async (id: string, status: string) => {
      meta.statusCalls.push({ id, status })
      const o = meta.objects.find((x) => x.id === id)
      if (o) o.body.status = status
      return { ok: true }
    },
  }
  return {
    getAdPlatform: () => ({ id: 'meta', label: 'Meta', budgetUnits: units, campaignCreation }),
    requireCapability: (p: Record<string, unknown>, c: string) => p[c],
  }
}

const COPY = [
  { primary_text: 'Book a bright studio by the hour with natural window light.', headline: 'Studio rental by the hour', description: '', cta: 'BOOK_NOW', angle: 'offer' },
  { primary_text: 'Natural window light makes product photos look true to life.', headline: 'Shoot in natural light', description: '', cta: 'BOOK_NOW', angle: 'specific_benefit' },
  { primary_text: 'No space at home for a shoot? Rent our studio for the afternoon.', headline: 'Your shoot, our space', description: '', cta: 'LEARN_MORE', angle: 'problem_solution' },
]

export function planSpec(startDate: string): CampaignPlanSpec {
  return campaignPlanSpecSchema.parse({
    currency: 'USD',
    campaign: { name: 'Spring prospecting', objective: 'OUTCOME_SALES', buying_type: 'AUCTION', budget_mode: 'CBO', daily_budget_minor: 3000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null },
    schedule: { start_date: startDate, end_date: null },
    conversion: { pixel_id: '111', custom_event: 'Purchase' },
    ad_sets: [{
      key: 'as1', name: 'Broad US', daily_budget_minor: null, optimization_goal: 'OFFSITE_CONVERSIONS',
      audience: { mode: 'advantage_plus', custom_audience_ids: [], excluded_audience_ids: [], countries: ['US'], age_min: 18, age_max: 65 },
      placements: 'advantage_plus',
      ads: COPY.map((copy, i) => ({ key: `ad${i + 1}`, name: `Ad ${i + 1}`, creative: { mode: 'image', image_hash: `hash00${i + 1}` }, copy, destination_url: 'https://studio.example/book', url_tags: PAID_TOUCH_URL_TAGS })),
    }],
  })
}

/** Account rows every plan test needs: pixel, page, currency and three synced image creatives. */
export async function seedPlanAccount(db: PGlite, accountId: string): Promise<void> {
  await db.query(`UPDATE public.ad_accounts SET pixel_id = '111', facebook_page_id = '555', currency = 'USD' WHERE id = $1`, [accountId])
  for (const n of [1, 2, 3]) {
    await db.query(`INSERT INTO public.creatives (ad_account_id, creative_id, creative_name, image_hash, thumbnail_url, last_synced_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [accountId, `70${n}`, `Creative ${n}`, `hash00${n}`, `https://cdn.example/thumb${n}.jpg`])
  }
}

type Submit = (input: { versionId: string; ownerUserId: string; confirmBudgetStep?: boolean }) => Promise<{ http: number; body: Record<string, unknown> }>

/** Draft (as a new plan), submit and approve one plan version through the shipped RPCs. */
export async function approvedPlan(db: PGlite, deps: { submit: Submit; hashSpec: (s: CampaignPlanSpec) => string; spec: CampaignPlanSpec; account: string; owner: string }): Promise<{ changeRequestId: string; versionId: string }> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_campaign_plan_version(NULL, $1, $2, $3, $4, $5)', [deps.account, deps.owner, 'Spring', '{}', JSON.stringify({
    spec: deps.spec, spec_hash: deps.hashSpec(deps.spec), currency: 'USD', total_daily_budget_minor: 3000, validation: [], readiness: [], notes: [], source: 'template',
  })])
  const submitted = await deps.submit({ versionId: rows[0].id, ownerUserId: deps.owner, confirmBudgetStep: true })
  expect(submitted.http).toBe(201)
  const changeRequestId = String(submitted.body.change_request_id)
  await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, true)', [changeRequestId, 'owner@example.test'])
  return { changeRequestId, versionId: rows[0].id }
}
