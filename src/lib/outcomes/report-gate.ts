import { sourceCompletenessLabel } from './completeness-label'
import { reconciliationCoversWindow, type SourceReconcileResult } from './reconciliation'
import { getOutcomeAdapter } from './registry'
import type { OutcomeSourceRef } from './source-health'

/**
 * Report gate for outcome sources (daily report, and the Monday weekly report built from it).
 *
 * - When any enabled source is reconciled against its own system (its adapter has `ledgerHealth` or
 *   `reconcile`), a lifecycle report still needs this run's reconciliation to cover its window.
 * - When every enabled source is push-only (signed webhook, CSV import), no reconciliation can ever
 *   run, so waiting for one skipped every report. The report is produced and records how its outcomes
 *   arrived ("As received", "As imported"); it makes no completeness claim about them.
 * - With no enabled source, or a source list that could not be read, the reconciliation gate decides,
 *   as before; the report's readers then say "no outcome source" rather than zero.
 */

/** Recorded on a report with push-only outcome sources: all of them, or (`mixed`) the push-only part of an
 *  install that also has reconciled sources. */
export interface ReportOutcomeArrival {
  sources: Array<{ source_id: string; kind: string; label: string }>
  /** Reconciled sources are enabled too; the labels cover only the push-only sources. */
  mixed?: true
}

/** How a report's outcome sources are complete: proven against their systems, counted as they arrived,
 *  or both. Distinct from money_basis.revenue_complete, which measures collected-value coverage. */
export type ReportSourceCompleteness = 'reconciled' | 'as_received' | 'mixed'

function isPushOnlyKind(kind: string): boolean {
  const adapter = getOutcomeAdapter(kind)
  return adapter !== null && typeof adapter.ledgerHealth !== 'function' && typeof adapter.reconcile !== 'function'
}

/** PURE. Null unless there is at least one enabled source and every one is push-only. */
export function pushOnlyOutcomeArrival(
  sources: readonly OutcomeSourceRef[] | null | undefined,
): ReportOutcomeArrival | null {
  if (!sources || sources.length === 0 || !sources.every((source) => isPushOnlyKind(source.kind))) return null
  return {
    sources: sources.map((source) => ({
      source_id: source.sourceId,
      kind: source.kind,
      label: sourceCompletenessLabel('push_as_received', source.kind),
    })),
  }
}

/** PURE. The arrival a report records: the push-only install's sources, the push-only part of a mixed
 *  install (marked `mixed`), or null when no enabled source is push-only. */
export function reportOutcomeArrival(
  sources: readonly OutcomeSourceRef[] | null | undefined,
): ReportOutcomeArrival | null {
  const pushOnly = pushOnlyOutcomeArrival(sources)
  if (pushOnly || !sources) return pushOnly
  const push = sources.filter((source) => isPushOnlyKind(source.kind))
  if (push.length === 0) return null
  return {
    sources: push.map((source) => ({
      source_id: source.sourceId,
      kind: source.kind,
      label: sourceCompletenessLabel('push_as_received', source.kind),
    })),
    mixed: true,
  }
}

/** PURE. The source completeness a report states, from the arrival it records. */
export function reportSourceCompleteness(arrival: ReportOutcomeArrival | null | undefined): ReportSourceCompleteness {
  return !arrival ? 'reconciled' : arrival.mixed ? 'mixed' : 'as_received'
}

/** PURE. The note under a report's collected-value figure when every counted outcome has a recorded value
 *  (revenue_complete). It names the sources' completeness and never calls push-only outcomes complete. */
export function collectedValueNote(
  words: { many: string },
  completeness: ReportSourceCompleteness | undefined,
  arrival: ReportOutcomeArrival | null | undefined,
): string {
  const base = `active ${words.many} only`
  if (!completeness || completeness === 'reconciled' || !arrival) return base
  const labels = [...new Set(arrival.sources.map((source) => source.label))].join(' · ')
  return completeness === 'mixed'
    ? `${base} · Reconciled + ${labels}`
    : `${base} · ${labels}: collected value recorded for every outcome counted; the source is not checked`
}

/** PURE. A stored report's stated source completeness and arrival, read defensively (older reports
 *  carry neither, and read as unstated). */
export function readReportSourceCompleteness(reportJson: Record<string, unknown> | null | undefined): {
  completeness: ReportSourceCompleteness | undefined
  arrival: ReportOutcomeArrival | null
} {
  const basis = reportJson?.money_basis as { source_completeness?: unknown } | undefined
  const value = basis?.source_completeness
  const completeness = value === 'reconciled' || value === 'as_received' || value === 'mixed' ? value : undefined
  const raw = reportJson?.outcome_arrival as { sources?: unknown; mixed?: unknown } | undefined
  const sources = Array.isArray(raw?.sources)
    ? raw.sources.filter((s): s is ReportOutcomeArrival['sources'][number] =>
      !!s && typeof s.source_id === 'string' && typeof s.kind === 'string' && typeof s.label === 'string')
    : []
  const arrival = sources.length > 0 ? { sources, ...(raw?.mixed === true ? { mixed: true as const } : {}) } : null
  return { completeness, arrival }
}

/** PURE. Whether a report may be produced for the window, given this run's outcome sources. */
export function reportOutcomesReady(input: {
  lifecycleRun: boolean
  arrival: ReportOutcomeArrival | null | undefined
  reconcile: SourceReconcileResult | null | undefined
  startDate: string
  endDate: string
}): boolean {
  // A mixed install still has a reconciled source, so it keeps the reconciliation gate.
  if (!input.lifecycleRun || (input.arrival && !input.arrival.mixed)) return true
  return reconciliationCoversWindow(input.reconcile, input.startDate, input.endDate)
}

/** PURE. The report-text line naming how push-only outcomes arrived; empty otherwise. */
export function outcomeArrivalLine(arrival: ReportOutcomeArrival | null | undefined): string {
  if (!arrival) return ''
  const labels = [...new Set(arrival.sources.map((source) => source.label))]
  if (arrival.mixed) {
    return `Outcomes: Reconciled · ${labels.join(' · ')}. The ${labels.join(' / ')} part is counted as it arrived; Maxx cannot check it against its own system.`
  }
  return `Outcomes: ${labels.join(' · ')}. Counted as they arrived; Maxx cannot check these sources against their own system.`
}
