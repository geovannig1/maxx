// The dashboard hero summarizes system/read health only. It deliberately does not consume CPA, ROAS,
// platform-modelled outcomes, historical benchmarks, or target bands. Current money/status guidance is
// rendered by the governed recommendation surfaces that carry persisted ActionDecision lineage.

import type { DataMode } from '@/lib/modes/operating-mode'

export type VerdictLevel = 'observed' | 'watch' | 'needs_attention' | 'dormant'

export interface VerdictInput {
  dataMode: DataMode
  criticalAlerts: number
  stale: boolean
  pendingApprovals: number
  metaRead: { available: boolean; unavailableReason?: string }
}

export interface AccountVerdict {
  level: VerdictLevel
  headline: string
  detail: string
  factors: string[]
  needsAttention: boolean
}

export function computeAccountVerdict(input: VerdictInput): AccountVerdict {
  if (!input.metaRead.available) {
    return {
      level: 'needs_attention',
      headline: 'Meta data unavailable',
      detail: 'No delivery or performance status is inferred from an unavailable read.',
      factors: [input.metaRead.unavailableReason ?? 'One or more Meta data sources could not be read'],
      needsAttention: true,
    }
  }

  if (input.dataMode === 'pre_launch') {
    return {
      level: 'dormant',
      headline: 'No live delivery observed',
      detail: 'Performance is not evaluated while the account is dormant. Use governed launch-readiness and recommendation surfaces for any proposed change.',
      factors: ['Account has negligible recent delivery'],
      needsAttention: false,
    }
  }

  if (input.criticalAlerts > 0) {
    return {
      level: 'needs_attention',
      headline: 'System review needed',
      detail: 'One or more critical diagnostic alerts require review. This hero does not prescribe a Meta change.',
      factors: [`${input.criticalAlerts} critical alert${input.criticalAlerts === 1 ? '' : 's'} unresolved (diagnostic)`],
      needsAttention: true,
    }
  }

  const watchReasons: string[] = []
  if (input.dataMode === 'low_data') watchReasons.push('Limited delivery evidence')
  if (input.stale) watchReasons.push('Data may be stale')
  if (input.pendingApprovals > 0) watchReasons.push(`${input.pendingApprovals} change${input.pendingApprovals === 1 ? '' : 's'} awaiting owner review (governed)`)
  if (watchReasons.length > 0) {
    return {
      level: 'watch',
      headline: 'Review data status',
      detail: 'The current evidence has a completeness, freshness, or owner-review caveat.',
      factors: watchReasons,
      needsAttention: input.pendingApprovals > 0,
    }
  }

  return {
    level: 'observed',
    headline: 'No system blockers observed',
    detail: 'Delivery data is present and current. Paid performance is not judged in this card; current guidance appears only in governed recommendations.',
    factors: ['No critical system alerts', 'Data freshness checks passed'],
    needsAttention: false,
  }
}

export function verdictTone(level: VerdictLevel): 'success' | 'warning' | 'danger' | 'neutral' {
  return level === 'watch' ? 'warning' : level === 'needs_attention' ? 'danger' : 'neutral'
}
