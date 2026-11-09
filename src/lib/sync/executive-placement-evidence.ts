import { getAdminClient } from '@/lib/supabase/admin'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import type { BreakdownRow, BreakdownSource, BreakdownType } from '@/lib/platforms/types'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const PLACEMENT_DIMENSIONS = ['publisher_platform', 'platform_position'] as const

interface PlacementEvidenceRow extends BreakdownRow {
  ad_account_id: string
  date_start: string
}

export interface ExecutivePlacementRefreshInput {
  adAccountDbId: string
  metaAccountId: string
  lastCompleteDate: string
}

export interface ExecutivePlacementRefreshResult {
  windowStart: string
  windowEnd: string
  rowCount: number
}

interface PlacementCommitInput {
  adAccountDbId: string
  windowStart: string
  windowEnd: string
  completedAt: string
  rows: PlacementEvidenceRow[]
}

interface ExecutivePlacementRefreshDeps {
  fetch: BreakdownSource['fetch']
  commit(input: PlacementCommitInput): Promise<number>
  now(): string
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (!DATE_PATTERN.test(date) || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Executive placement window date is invalid.')
  }
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

async function commitPlacementWindow(input: PlacementCommitInput): Promise<number> {
  const { data, error } = await getAdminClient().rpc('replace_executive_placement_window', {
    p_ad_account_id: input.adAccountDbId,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_rows: input.rows,
    p_completed_at: input.completedAt,
  })
  if (error) throw new Error(`replaceExecutivePlacementWindow failed: ${error.message}`)
  const count = Number(data)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('replaceExecutivePlacementWindow returned an invalid row count.')
  }
  return count
}

const DEFAULT_DEPS: ExecutivePlacementRefreshDeps = {
  fetch: (query) => requireCapability(getAdPlatform('meta'), 'breakdowns').fetch(query),
  commit: commitPlacementWindow,
  now: () => new Date().toISOString(),
}

/** Refresh the exact trailing-seven placement evidence window before an ExecutiveEvidenceSnapshot is
 * built. Fetch completes in memory first; a failed Meta dimension never replaces a complete snapshot. */
export async function refreshExecutivePlacementEvidence(
  input: ExecutivePlacementRefreshInput,
  deps: ExecutivePlacementRefreshDeps = DEFAULT_DEPS,
): Promise<ExecutivePlacementRefreshResult> {
  if (!input.adAccountDbId.trim() || !input.metaAccountId.trim()) {
    throw new Error('Executive placement account identity is unavailable.')
  }
  const windowEnd = shiftDate(input.lastCompleteDate, 0)
  const windowStart = shiftDate(windowEnd, -6)
  const rows: PlacementEvidenceRow[] = []

  for (let offset = 0; offset < 7; offset += 1) {
    const date = shiftDate(windowStart, offset)
    for (const dimension of PLACEMENT_DIMENSIONS) {
      const fetched = await deps.fetch({
        accountId: input.metaAccountId,
        level: 'adset',
        since: date,
        until: date,
        breakdowns: [dimension as BreakdownType],
        strict: true,
      })
      if (fetched.some((row) => row.entity_level !== 'adset' || row.breakdown_type !== dimension)) {
        throw new Error(`Executive placement source returned a mismatched ${dimension} slice.`)
      }
      rows.push(...fetched.map((row) => ({
        ...row,
        ad_account_id: input.adAccountDbId,
        date_start: date,
      })))
    }
  }

  const completedAt = deps.now()
  if (!Number.isFinite(Date.parse(completedAt))) {
    throw new Error('Executive placement completion time is invalid.')
  }
  const rowCount = await deps.commit({
    adAccountDbId: input.adAccountDbId,
    windowStart,
    windowEnd,
    completedAt,
    rows,
  })
  if (rowCount !== rows.length) {
    throw new Error('Executive placement commit row count does not match the fetched snapshot.')
  }
  return { windowStart, windowEnd, rowCount }
}
