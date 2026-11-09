import { roundMoney } from '@/lib/utils/format-currency'
import {
  MAXX_OWNER_PROFIT_POLICY,
} from './profit-policy'
import type { getAdminClient } from '@/lib/supabase/admin'
import { SETTINGS_KEYS } from '@/types/db'
import type { InteractionCohortPairSignal } from '@/lib/modes/operating-mode'

/**
 * PRAGMATIC MEDIA-BUYER PROFIT EVIDENCE
 *
 * The profit pipeline requires processor-settled collections, refunds, payment fees, governed
 * variable costs, and a governed comparison before it can support a money direction.
 *
 * Appointment booked value is not processor-settled cash. This module may expose booked-value
 * diagnostics, but it must never manufacture settled collections, refunds, fees, variable costs,
 * payment counts, or an owner-approved ceiling from that proxy. Until those sources are connected,
 * the profit bridge returns null and all money direction fails closed.
 */

export const PRAGMATIC_COST_POLICY_VERSION = 'pragmatic-media-buyer-v1'
export const PRAGMATIC_DECISION_PACKAGE_ID = 'pragmatic-media-buyer-attributed-association-v1'
export const PRAGMATIC_SCALE_DESIGN_ID = 'exact-paid-attributed-scale-v1'
export const PRAGMATIC_CUT_DESIGN_ID = 'exact-paid-attributed-cut-v1'

/** Compatibility alias. A feature flag cannot raise the durably governed owner ceiling. */
export const PRAGMATIC_DAILY_BUDGET_CEILING = MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling

/** Owner ROAS target, expressed as a range anchored to the account's observed history instead of a
 *  single aspirational number. The values below are illustrative defaults for a small service
 *  business; replace them with what your own account has demonstrated.
 *  - FLOOR: below 2x blended, the account is assumed not to cover overhead — review, don't scale.
 *  - STRETCH: 6x stands for the top of what an account has actually demonstrated on its best days.
 *  Used to label upside and shortfall, never to fabricate evidence. */
export const OWNER_ROAS_TARGET_FLOOR = 2
export const OWNER_ROAS_TARGET_STRETCH = 6

export interface PragmaticPaidWindowInput {
  spend: number
  bookedValue: number
  bookings: number
  windowStart: string
  windowEnd: string
}

export interface PragmaticProfitInput {
  currentAccountDailyBudget: number | null
  proposedAccountDailyBudget: number | null
  recent: PragmaticPaidWindowInput
  matured: PragmaticPaidWindowInput | null
}

/**
 * Booked appointment value cannot populate the profit input expected by paid-cohort-direction.
 */
export function buildPragmaticProfitInput(
  _input: PragmaticProfitInput,
): null {
  void _input
  return null
}

/** True when the feature flag enabling pragmatic media-buyer recommendations is on. */
export function isPragmaticMediaBuyerEnabled(): boolean {
  return process.env.ENABLE_MEDIA_BUYER_RECOMMENDATIONS === 'true'
}

/**
 * Read the only durably governed account ceiling. Feature flags do not create owner approval.
 */
export function pragmaticDailyBudgetCeiling(): number {
  return MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling
}

/** Read the owner-controlled pragmatic media-buyer toggle from durable app settings.
 *
 * Falls back to the `ENABLE_MEDIA_BUYER_RECOMMENDATIONS` environment variable when the row is missing,
 * so local/dev harnesses keep working without a seeded setting.
 */
export async function readMediaBuyerRecommendationsEnabled(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('app_settings')
    .select('value, setting_type')
    .eq('ad_account_id', adAccountDbId)
    .eq('key', SETTINGS_KEYS.MEDIA_BUYER_RECOMMENDATIONS)
    .maybeSingle()
  if (error || !data) return isPragmaticMediaBuyerEnabled()
  const raw = String(data.value ?? '').trim().toLowerCase()
  if (data.setting_type === 'boolean') return raw === 'true'
  return raw === 'true' || raw === '1'
}

/** Compute the live active account-total daily budget from synced DB state.
 *
 * Active CBO campaign daily budgets + active ABO ad-set daily budgets for campaigns without CBO.
 * Lifetime-only budgets make the daily exposure unknowable and return null.
 */
export async function computeActiveAccountDailyBudget(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
): Promise<number | null> {
  const [{ data: campaigns, error: cErr }, { data: adsets, error: aErr }] = await Promise.all([
    db
      .from('campaigns')
      .select('id, daily_budget, lifetime_budget')
      .eq('ad_account_id', adAccountDbId)
      .eq('effective_status', 'ACTIVE'),
    db
      .from('adsets')
      .select('id, campaign_id, daily_budget, lifetime_budget')
      .eq('ad_account_id', adAccountDbId)
      .eq('effective_status', 'ACTIVE'),
  ])
  if (cErr || aErr) return null

  const cboCampaigns = new Set<string>()
  let total = 0
  for (const c of campaigns ?? []) {
    if (typeof c.id !== 'string') return null
    if (c.daily_budget != null) {
      const budget = Number(c.daily_budget)
      if (!Number.isFinite(budget) || budget < 0) return null
      cboCampaigns.add(c.id)
      total += budget
    } else if (c.lifetime_budget != null) {
      // An active lifetime-only campaign has no safe daily equivalent.
      return null
    }
  }
  for (const s of adsets ?? []) {
    if (typeof s.id !== 'string' || typeof s.campaign_id !== 'string') return null
    if (cboCampaigns.has(s.campaign_id)) continue
    if (s.daily_budget == null) return null
    const budget = Number(s.daily_budget)
    if (!Number.isFinite(budget) || budget < 0) return null
    total += budget
  }
  return Number.isFinite(total) ? roundMoney(total) : null
}

/** A 20% sizing helper, capped at the durably governed account ceiling. */
export function recommendedScaleBudget(currentAccountDailyBudget: number | null): number | null {
  if (currentAccountDailyBudget == null || !Number.isFinite(currentAccountDailyBudget)) return null
  const proposed = Math.min(currentAccountDailyBudget * 1.2, PRAGMATIC_DAILY_BUDGET_CEILING)
  const rounded = roundMoney(proposed)
  return rounded > currentAccountDailyBudget ? rounded : null
}

/** Paid-cohort booked value is diagnostic and cannot be promoted into profit evidence. */
export function buildPragmaticProfitInputFromCohortPair(
  _pair: InteractionCohortPairSignal,
  _currentAccountDailyBudget: number | null,
): null {
  void _pair
  void _currentAccountDailyBudget
  return null
}
