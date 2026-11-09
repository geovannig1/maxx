import { logToolError } from '@/lib/security/api-error'
import { buildQualityReport } from '@/lib/diagnostics/quality-report'
import { getApprovedVerticalBenchmarks } from '@/lib/targets/vertical-benchmarks'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'

// MCP tool: per-ad auction quality rankings (Meta's own relative tiers) + per-ad-set delivery evidence,
// plus any OWNER-APPROVED
// vertical benchmarks as labeled context. Read-only; shares the gatherer with /api/diagnostics/quality.

export async function getAuctionDiagnostics(args: { window_days?: number }): Promise<object> {
  const windowDays = Math.min(Math.max(args?.window_days ?? 30, 1), 90)
  try {
    const activeAccount = await resolveOnlyActiveAccount()
    if (!activeAccount.ok) return { available: false, reason: `active account ${activeAccount.reason}` }
    const to = await readLatestClosedAccountDeliveryDate(activeAccount.account.id)
    if (to === null) {
      return { available: false, reason: 'latest closed account delivery day unavailable' }
    }
    const fromDate = new Date(`${to}T00:00:00Z`)
    fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1))
    const from = fromDate.toISOString().slice(0, 10)
    const [report, benchmarks] = await Promise.all([
      buildQualityReport({ from, to }),
      getApprovedVerticalBenchmarks().catch(() => []),
    ])
    return {
      ...report,
      // Owner-approved (on /signals), cited, external_heuristic CONTEXT — never re-bands a metric.
      // Empty until the owner approves the seeded entries: then say "no vertical benchmark available".
      vertical_benchmarks: benchmarks,
      action_authority: {
        tier: 'diagnostic_only',
        prescriptions: [],
        reason_code: 'auction_delivery_evidence_only',
      },
      note: "quality/engagement/conversion rankings are META'S relative tiers (vs ads competing for the same audience). Per-ad-set delivery_diagnostic reports pacing, frequency, and auction-ranking evidence only; it does not evaluate paid outcomes or authorize a change. Unrated ads are 'unrated', not bad. vertical_benchmarks are cited external heuristics for context only.",
    }
  } catch (e) {
    return { available: false, error_code: 'AUCTION_DIAGNOSTICS_FAILED', reason: logToolError('get_auction_diagnostics', 'AUCTION_DIAGNOSTICS_FAILED', e) }
  }
}
