// ADR-062 test fixtures: a sound plan and an account context it validates against.
import { campaignPlanSpecSchema, PAID_TOUCH_URL_TAGS, type CampaignPlanSpec } from '@/lib/campaigns/plan-spec'
import type { PlanValidationContext } from '@/lib/campaigns/plan-validation'
import { scoreCopy } from '@/lib/creative/copy-scorer'

const facts = { facts: { statements: ['Studio rental by the hour', 'Natural window light'], unverified: [] } }

const COPIES = [
  { primary_text: 'Book a bright studio by the hour with natural window light.', headline: 'Studio rental by the hour', description: '', cta: 'BOOK_NOW', angle: 'offer' },
  { primary_text: 'Natural window light makes product photos look true to life.', headline: 'Shoot in natural light', description: '', cta: 'BOOK_NOW', angle: 'specific_benefit' },
  { primary_text: 'No space at home for a shoot? Rent our studio for the afternoon.', headline: 'Your shoot, our space', description: '', cta: 'LEARN_MORE', angle: 'problem_solution' },
]

export function validSpec(): CampaignPlanSpec {
  return campaignPlanSpecSchema.parse({
    currency: 'USD',
    campaign: { name: 'Spring prospecting', objective: 'OUTCOME_SALES', buying_type: 'AUCTION', budget_mode: 'CBO', daily_budget_minor: 3000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null },
    schedule: { start_date: '2026-11-10', end_date: null },
    conversion: { pixel_id: '111', custom_event: 'Purchase' },
    ad_sets: [{
      key: 'as1', name: 'Broad US', daily_budget_minor: null, optimization_goal: 'OFFSITE_CONVERSIONS',
      audience: { mode: 'advantage_plus', custom_audience_ids: [], excluded_audience_ids: ['900'], countries: ['US'], age_min: 18, age_max: 65 },
      placements: 'advantage_plus',
      ads: [1, 2, 3].map((n) => ({
        key: `ad${n}`, name: `Ad ${n}`, creative: { mode: 'image', image_hash: `hash00${n}` },
        copy: COPIES[n - 1],
        destination_url: 'https://studio.example/book', url_tags: PAID_TOUCH_URL_TAGS,
      })),
    }],
  })
}

export function context(over: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return {
    accountCurrency: 'USD', metaAccountId: 'act_1', currencySupported: true, configuredCurrencyProblem: null, today: '2026-11-08',
    minDailyBudgetMinor: (goal) => (goal === 'OFFSITE_CONVERSIONS' ? 500 : 100), ceilingMinor: 20_000,
    accountActiveDailyMinor: 6000, maxStepPercent: 50, pageId: '555',
    audiences: new Map([['900', { name: 'Past buyers', approximateCount: 4000, metaAccountId: 'act_1' }], ['901', { name: 'Other', approximateCount: 3000, metaAccountId: 'act_2' }]]),
    creativeIds: new Set(['777']), imageHashes: new Set(['hash001', 'hash002', 'hash003']), videoIds: new Set(['888']),
    pixelId: '111', thumbnailUrls: new Set(['https://cdn.example/thumb888.jpg']),
    landingHosts: ['studio.example'], scoreCopy: (copy) => scoreCopy({ ...copy, hook: null }, facts),
    ...over,
  }
}

