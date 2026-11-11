import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import { adPlatformForAccount } from '@/lib/platforms/account-platform'
import type { BudgetRow } from '@/lib/platforms/types'
import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import { formatMoney, roundMoney } from '@/lib/utils/format-currency'
import { accountCurrency } from '@/config/business-config'
import { SPEND_FLOORS } from '@/config/spend-floors'
import { currencyMismatch, writeCarriesMoney } from './write-currency'
import type { GovernedWriteRequest } from './write-authority'
import {
  expectedEntityLevel,
  fieldsForWriteSnapshot,
  isSafeMetaEntityId,
  normalizeMetaAccountId,
  projectWriteSnapshot,
} from './meta-live-state'

// The governed-write preconditions shared by proposal (propose-change.ts) and execution (executor.ts):
// the daily-budget hard bounds, the live account-total budget, the before/after-state read, and the
// binding of a Meta target to the selected account. Split out of executor.ts with no behavior change;
// executor.ts re-exports the public names.

// The governed write path is Meta's: it validates Meta entity and account ids and Meta snapshots
// (meta-live-state.ts). Its one platform binding is below; resolveWriteTargetContext refuses an account
// whose own platform (ad_accounts.platform) is any other, before any read or write. A second platform
// needs its own write path first. Every gate stays in the callers.
const GOVERNED_WRITE_PLATFORM = 'meta'
const writePlatform = () => getAdPlatform(GOVERNED_WRITE_PLATFORM)
export const metaWrites = () => requireCapability(writePlatform(), 'writes')
export const fromMetaMinorUnits = (minor: number, currency?: string) => writePlatform().budgetUnits.fromMinor(minor, currency)
export const toMetaMinorUnits = (amount: number, currency?: string) => writePlatform().budgetUnits.toMinor(amount, currency)

// Daily-budget hard bounds — enforced at propose time AND re-checked before any Meta call, for every
// action that sets a budget (adjust_budget and duplicate_adset's optional budget override).
/** In the account currency: 1/20 of NEXT_PUBLIC_MIN_SPEND_TO_JUDGE, so 1 at the USD default. */
export const budgetMin = () => SPEND_FLOORS.minDailyBudget
export const BUDGET_HARD_CAP = MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling
export const BUDGET_TOLERANCE = 0.01

/** Execution-time hard-bounds check for any budget about to be sent to Meta. Returns an error string
 *  when out of bounds (or non-finite), else null. Called immediately before EVERY Meta budget write
 *  (adjust_budget AND the duplicate_adset override) — the last-line defense the file header promises,
 *  independent of the propose-time validation which a legacy/altered request could have bypassed. */
export function validateBudgetAmount(v: unknown): string | null {
  const amount = Number(v)
  if (!isFinite(amount) || amount < budgetMin() || amount > BUDGET_HARD_CAP) {
    return `budget out of bounds (${formatMoney(budgetMin())}–${formatMoney(BUDGET_HARD_CAP)}/day): ${String(v)}`
  }
  return null
}

/** Pure account-total projection. The target's old ABO budget is replaced, not added twice. */
export function proposedAccountBudgetTotal(input: {
  currentAccountTotal: number
  targetCurrentBudget: number
  targetProposedBudget: number
}): number | null {
  const values = [input.currentAccountTotal, input.targetCurrentBudget, input.targetProposedBudget]
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) return null
  const projected = input.currentAccountTotal - input.targetCurrentBudget + input.targetProposedBudget
  return Number.isFinite(projected) && projected >= -BUDGET_TOLERANCE
    ? Math.max(0, roundMoney(projected))
    : null
}

/** A database failure: logged server-side, returned only as a stable code. */
export function databaseError(step: string, failure: { message: string }): { status: 'ERROR'; error: 'DATABASE_ERROR' } {
  console.error(`[WRITE] ${step} failed:`, failure.message)
  return { status: 'ERROR', error: 'DATABASE_ERROR' }
}

export type WriteActionType = GovernedWriteRequest['actionType']

/** Live configured account budget: active CBO campaign budgets plus active ABO ad-set budgets for
 * campaigns without CBO. A partial/unparseable read returns null and blocks the write. */
export async function activeAccountConfiguredDailyBudget(metaAccountId: string, currency: string): Promise<number | null> {
  const normalized = normalizeMetaAccountId(metaAccountId)
  if (!normalized) return null

  let campaigns: BudgetRow[] | null
  let adsets: BudgetRow[] | null
  try {
    ({ campaigns, adsets } = await metaWrites().readActiveBudgetRows(normalized))
  } catch {
    return null
  }
  if (!campaigns || !adsets) return null

  const cboCampaigns = new Set<string>()
  let cents = 0
  for (const campaign of campaigns) {
    if (typeof campaign.id !== 'string') return null
    if (campaign.daily_budget == null) {
      // An active campaign-level lifetime budget has no safe daily equivalent. An active campaign
      // with neither budget may be ABO, whose exposure is counted from its ad sets below.
      if (campaign.lifetime_budget != null) return null
      continue
    }
    const budget = Number(campaign.daily_budget)
    if (!Number.isFinite(budget) || budget < 0) return null
    cboCampaigns.add(campaign.id)
    cents += budget
  }
  for (const adset of adsets) {
    if (typeof adset.id !== 'string' || typeof adset.campaign_id !== 'string') return null
    if (cboCampaigns.has(adset.campaign_id)) continue
    // Outside a recognized daily-CBO campaign, every active ad set must expose a daily budget.
    // Lifetime or absent budgets make the account-total daily exposure unknowable, so fail closed.
    if (adset.daily_budget == null) return null
    const budget = Number(adset.daily_budget)
    if (!Number.isFinite(budget) || budget < 0) return null
    cents += budget
  }
  return Number.isFinite(cents) ? fromMetaMinorUnits(Math.round(cents), currency) : null
}

export async function captureState(actionType: WriteActionType, entityId: string): Promise<Record<string, unknown> | null> {
  const raw = await metaWrites().readEntity(entityId, fieldsForWriteSnapshot(actionType))
  return projectWriteSnapshot(actionType, entityId, raw)
}

export type WriteTargetContext =
  | { ok: true; metaAccountId: string; currency: string }
  | { ok: false; status: 'PRECONDITION_UNAVAILABLE' | 'OWNERSHIP_UNVERIFIED' | 'CURRENCY_MISMATCH'; message: string }

/**
 * Bind a Meta target to the selected database account before any network call. This makes guessed or
 * cross-account ids a zero-network rejection; Meta ownership is checked again from the live response.
 */
export async function resolveWriteTargetContext(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  actionType: WriteActionType,
  entityLevel: GovernedWriteRequest['entityLevel'],
  entityId: string,
  params: Record<string, unknown>,
): Promise<WriteTargetContext> {
  if (!isSafeMetaEntityId(entityId)) {
    return { ok: false, status: 'OWNERSHIP_UNVERIFIED', message: 'The Meta entity id is invalid.' }
  }
  if (entityLevel !== expectedEntityLevel(actionType)) {
    return { ok: false, status: 'OWNERSHIP_UNVERIFIED', message: 'The action type and entity level do not match.' }
  }

  const { data: account, error: accountError } = await db
    .from('ad_accounts')
    .select('account_id, is_active, currency, platform')
    .eq('id', adAccountDbId)
    .maybeSingle()
  if (accountError) {
    return { ok: false, status: 'PRECONDITION_UNAVAILABLE', message: 'The owning Meta account could not be read.' }
  }
  let accountPlatform: ReturnType<typeof adPlatformForAccount> | null = null
  try { accountPlatform = account ? adPlatformForAccount(account) : null } catch { accountPlatform = null }
  if (account && accountPlatform?.id !== GOVERNED_WRITE_PLATFORM) {
    return { ok: false, status: 'PRECONDITION_UNAVAILABLE', message: 'Governed changes support Meta ad accounts only; this account belongs to another or an unknown ad platform.' }
  }
  const metaAccountId = normalizeMetaAccountId(account?.account_id)
  if (!metaAccountId || account?.is_active !== true) {
    return { ok: false, status: 'OWNERSHIP_UNVERIFIED', message: 'The owning Meta account is missing, inactive, or invalid.' }
  }
  if (writeCarriesMoney(actionType, params)) {
    const mismatch = currencyMismatch(account?.currency, writePlatform().budgetUnits)
    if (mismatch) return { ok: false, status: 'CURRENCY_MISMATCH', message: mismatch }
  }

  const table = entityLevel === 'ad' ? 'ads' : 'adsets'
  const idColumn = entityLevel === 'ad' ? 'ad_id' : 'adset_id'
  const { data: localEntity, error: entityError } = await db
    .from(table)
    .select('id')
    .eq(idColumn, entityId)
    .eq('ad_account_id', adAccountDbId)
    .maybeSingle()
  if (entityError) {
    return { ok: false, status: 'PRECONDITION_UNAVAILABLE', message: 'The local target ownership record could not be read.' }
  }
  if (!localEntity) {
    return { ok: false, status: 'OWNERSHIP_UNVERIFIED', message: 'The target is not owned by the selected ad account.' }
  }
  return { ok: true, metaAccountId, currency: accountCurrency() }
}
