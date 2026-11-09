// Converts diagnostics into investigation drafts. Governed reallocations keep their explicit authority
// tier; auction/delivery evidence never becomes a money or status instruction here.

import type { AnomalyExplanation } from './anomaly'
import type { DeliveryDiagnosticResult } from './opportunity'
import type { Reallocation } from '@/lib/recommendations/reallocation'
import { formatMoneyAmount } from '@/lib/utils/format-currency'

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'
export type TaskSource = 'anomaly' | 'delivery_diagnostic' | 'reallocation' | 'creative_test'

export interface TaskDraft {
  title: string
  description: string
  recommendation: string
  priority: TaskPriority
  source: TaskSource
}

/** Worsened efficiency metrics → investigate tasks. Trust bounds the priority: a spike we can't trust
 *  becomes a lower-priority "verify" rather than an urgent "act". */
export function anomaliesToTasks(anomalies: AnomalyExplanation[]): TaskDraft[] {
  const out: TaskDraft[] = []
  for (const a of anomalies) {
    if (a.severity === 'none' || a.severity === 'low') continue
    const trusted = a.trust == null || a.trust.meetsBar
    const priority: TaskPriority = a.severity === 'high' ? (trusted ? 'high' : 'medium') : trusted ? 'medium' : 'low'
    const trustNote = a.trust && !a.trust.meetsBar ? ` (trust ${a.trust.score}% — verify before acting)` : ''
    const driver = a.driver ? ` ${a.driver}.` : ''
    const mover = a.topMovers[0] ? ` Concentrated in “${a.topMovers[0].name}”.` : ''
    out.push({
      title: `Investigate ${a.label} ${a.changePct != null ? `${a.changePct > 0 ? '+' : ''}${a.changePct.toFixed(0)}%` : 'movement'}`,
      description: a.headline,
      recommendation: `${driver}${mover} Verify the source and record the evidence.${trustNote}`.trim(),
      priority,
      source: 'anomaly',
    })
  }
  return out
}

/** Notable delivery observations can create an investigation only. Ordinary or incomplete evidence creates no
 * task and no proposed action. */
export function deliveryDiagnosticsToTasks(items: Array<{ name: string; diagnostic: DeliveryDiagnosticResult }>): TaskDraft[] {
  return items
    .filter((item) => item.diagnostic.status === 'notable_observation')
    .map((i) => ({
      title: `Investigate auction or delivery observations for “${i.name}”`,
      description: i.diagnostic.summary,
      recommendation: `Review the ${i.diagnostic.signals.filter((signal) => signal.state === 'notable').map((signal) => signal.label).join(' and ')} evidence and record any setup or delivery changes. Route any proposed action through governed recommendations.`,
      priority: 'low' as TaskPriority,
      source: 'delivery_diagnostic' as TaskSource,
    }))
}

/** Only authority-cleared reallocations may reach this adapter. The route currently supplies none on
 * Meta-modelled evidence; the tier remains explicit so a future caller cannot omit that fact. */
export function reallocationsToTasks(reallocs: Reallocation[]): TaskDraft[] {
  return reallocs.map((r) => ({
    title: `Reallocate ${formatMoneyAmount(r.suggestedShiftDaily)}/day: ${r.fromName} → ${r.toName}`,
    description: r.rationale,
    recommendation: `Authority tier: ${r.authorityTier}. Owner approval and write mode are still required before any Meta change.`,
    priority: r.authorityTier === 'execution_eligible' ? 'high' : 'medium',
    source: 'reallocation',
  }))
}
