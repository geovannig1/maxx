import type { getAdminClient } from '@/lib/supabase/admin'
import type { ExecutiveEvidenceSnapshotV1 } from '@/lib/report/executive-evidence'
import type { AccountInsights } from './prompt-builder'
import {
  buildDailyDigest,
  type DailyDigestInput,
  type DailyDigestV3,
} from './daily-digest'
import { sumDailyBudgetTarget } from './daily-digest-signals'

type Db = ReturnType<typeof getAdminClient>

/** NUMERIC columns can arrive as strings. An unparseable budget is unknown, never 0. */
function toBudget(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Absent, null or non-string statuses are UNKNOWN, never a status string of their own. */
function toStatus(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/**
 * Pacing target = summed ACTIVE daily budgets (campaign level for CBO, ad-set level for ABO).
 * Campaigns are keyed by `campaigns.id`, the DB uuid PK that `adsets.campaign_id` references — NOT
 * the Meta `campaign_id` text column, which would match nothing and silently yield a null target.
 * `effective_status` is read alongside `status` because it is the column that reflects parent
 * pauses, disapprovals and schedule state — i.e. whether the entity can actually spend today.
 *
 * NON-BLOCKING BY CONTRACT: every failure path returns null, so pacing degrades to 'unavailable'
 * (amber) and report generation still commits. This function never throws.
 */
export async function readDailyBudgetTarget(supabase: Db, adAccountDbId: string): Promise<number | null> {
  try {
    const [campaigns, adsets] = await Promise.all([
      supabase.from('campaigns').select('id, status, effective_status, daily_budget').eq('ad_account_id', adAccountDbId),
      supabase.from('adsets').select('campaign_id, status, effective_status, daily_budget').eq('ad_account_id', adAccountDbId),
    ])
    if (campaigns.error || adsets.error) {
      console.warn('[Report] daily budget target unreadable — pacing reports unverified:',
        campaigns.error?.message ?? adsets.error?.message)
      return null
    }
    return sumDailyBudgetTarget(
      (campaigns.data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        status: String(row.status ?? ''),
        effective_status: toStatus(row.effective_status),
        daily_budget: toBudget(row.daily_budget),
      })),
      (adsets.data ?? []).map((row: Record<string, unknown>) => ({
        campaign_id: String(row.campaign_id),
        status: toStatus(row.status),
        effective_status: toStatus(row.effective_status),
        daily_budget: toBudget(row.daily_budget),
      })),
    )
  } catch (error) {
    console.warn('[Report] daily budget target read failed — pacing reports unverified:', error)
    return null
  }
}

export interface CommittedDigestInput {
  reportDate: string
  accountName: string
  accountInsights: AccountInsights | null
  sevenDayDailyAverage: AccountInsights | null
  /** outcome ledger, today. Null renders an "unavailable" KPI row — NEVER 0 for absent data. */
  ledgerBookingsToday: number | null
  /** outcome ledger, prior seven-day DAILY AVERAGE — the same window the Meta baseline averages. */
  ledgerBookingsPriorSevenDayAverage: number | null
  /** Canonical evidence snapshot. A committed V3 digest cannot exist without this binding. */
  executiveEvidence: ExecutiveEvidenceSnapshotV1
  /** Legacy caller seam only. V3 does not read a current budget as historical pacing evidence. */
  readDailyBudgetTarget?: () => Promise<number | null>
  /** Legacy caller compatibility only. V3 never invokes a model for its narrative. */
  llm?: unknown
  deadlineMs?: number
}

type DigestPlanes = DailyDigestInput['today']

function rate(numerator: number | null, denominator: number): number | null {
  return numerator !== null && denominator > 0 ? (numerator / denominator) * 100 : null
}

function cost(numerator: number | null, denominator: number | null): number | null {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null
}

/** Current V3 facts come from the same normalized snapshot that is committed beside the report.
 * A missing snapshot plane stays null; parallel reads are never used as a fallback. */
export function projectDailyDigestPlanesFromEvidence(
  evidence: ExecutiveEvidenceSnapshotV1,
): { today: DigestPlanes; priorSevenDailyAverage: DigestPlanes } {
  const currentMeta = evidence.meta?.byWindow.lastDay ?? null
  const priorMeta = evidence.meta?.byWindow.prior7 ?? null
  const currentOutcome = evidence.outcomes?.byWindow.lastDay ?? null
  const priorOutcome = evidence.outcomes?.byWindow.prior7 ?? null
  return {
    today: {
      spend: currentMeta?.spendAmount ?? null,
      leads: currentMeta?.leads ?? null,
      bookings: currentMeta?.modeledBookings ?? null,
      ctr: currentMeta ? rate(currentMeta.linkClicks, currentMeta.impressions) : null,
      cpl: currentMeta ? cost(currentMeta.spendAmount, currentMeta.leads) : null,
      bookingsReal: currentOutcome?.valueBearingBookings ?? null,
    },
    priorSevenDailyAverage: {
      spend: priorMeta ? priorMeta.spendAmount / 7 : null,
      leads: priorMeta?.leads === null || priorMeta === null ? null : priorMeta.leads / 7,
      bookings: priorMeta?.modeledBookings === null || priorMeta === null ? null : priorMeta.modeledBookings / 7,
      ctr: priorMeta ? rate(priorMeta.linkClicks, priorMeta.impressions) : null,
      cpl: priorMeta ? cost(priorMeta.spendAmount, priorMeta.leads) : null,
      bookingsReal: priorOutcome ? priorOutcome.valueBearingBookings / 7 : null,
    },
  }
}

/**
 * THE digest path used by report generation. Every wiring decision lives here so it is executable
 * under test: both booking planes and the executive evidence snapshot.
 * V3 constructs its narrative deterministically in the same pure build, so there is no asynchronous
 * prose step and no stale-markdown mutation path.
 */
export async function buildCommittedDailyDigest(input: CommittedDigestInput): Promise<DailyDigestV3> {
  if (!input.executiveEvidence) {
    throw new Error('Executive evidence snapshot is required for a committed Daily V3 digest')
  }
  const evidencePlanes = projectDailyDigestPlanesFromEvidence(input.executiveEvidence)
  const digest = buildDailyDigest({
    reportDate: input.reportDate,
    accountName: input.accountName,
    today: evidencePlanes.today,
    sevenDayDailyAverage: evidencePlanes.priorSevenDailyAverage,
    // A current daily budget is not historical pacing evidence. V3 stays unclassified until an
    // exact budget-effective interval is available for the full trailing seven-day window.
    dailyBudgetTarget: null,
    executiveEvidence: input.executiveEvidence,
  })
  return digest
}
