import { CheckCircle2, AlertTriangle, CircleDashed } from 'lucide-react'
import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'
import { EVIDENCE_PLANE_LABEL } from '@/lib/cockpit/contracts'
import { blockerLabels } from '@/lib/diagnostics/blocker-labels'
import { outcomeNoun } from '@/config/outcome-nouns'

// Governed launch readiness, computed from what this install actually read. It used to be a constant
// list copied from one account's audit — "Verified" for checks nobody ran here and "Blocked" for
// checks with no reader — so it said the same thing on every install whatever the data held. Each row
// now carries the state its evidence supports, and a check with no reader says so, never pass or fail.

type SourceRow = PerformanceCockpitData['sourceHealth'][number]

export type ReadinessState = 'verified' | 'attention' | 'not_measured'

export interface ReadinessCheck { key: string; label: string; state: ReadinessState; detail: string }

const STATE_COPY: Record<ReadinessState, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'var(--success)' },
  attention: { label: 'Needs attention', color: 'var(--warning)' },
  not_measured: { label: 'Not measured', color: 'var(--text-tertiary)' },
}

const PLANE_CHECKS: ReadonlyArray<{ plane: SourceRow['plane']; verified: string; absent: string }> = [
  {
    plane: 'meta_delivery',
    verified: 'Spend and results are synced and complete for the checked window.',
    absent: 'Meta delivery could not be read for the checked window.',
  },
  {
    plane: 'outcome_business',
    verified: `The ${outcomeNoun({ plural: false })} ledger is reconciled through the checked window.`,
    absent: `No reconciled ${outcomeNoun({ plural: false })} ledger has reported its health yet, so it is not shown as passed or blocked.`,
  },
  {
    plane: 'ga4_telemetry',
    verified: 'GA4 confirmation telemetry is current for the checked window.',
    absent: 'GA4 telemetry health has not been recorded, so it is not shown as passed or blocked.',
  },
]

/** Checks this install has no reader for. Stated so the owner knows they exist; never a pass or a block. */
const UNMEASURED: ReadonlyArray<Pick<ReadinessCheck, 'key' | 'label' | 'detail'>> = [
  { key: 'paid_touch_identity', label: 'Paid-touch identity', detail: 'Exact paid-touch identity for paid cohorts is not read on this page. Paid CPA and ROAS stay unavailable until it is proven.' },
  { key: 'browser_server_dedup', label: 'Browser/server dedup', detail: 'No durable browser Pixel event_id receipt is recorded, so paired browser/server deduplication cannot be verified here.' },
]

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** PURE. One check per evidence plane (state from the plane's own health row), then the unmeasured ones. */
export function launchReadinessChecks(sourceHealth: readonly SourceRow[] | null): ReadinessCheck[] {
  const planes = PLANE_CHECKS.map(({ plane, verified, absent }): ReadinessCheck => {
    const row = sourceHealth?.find((source) => source.plane === plane)
    const label = sentenceCase(EVIDENCE_PLANE_LABEL[plane])
    // Meta delivery is the one plane every install must establish, so failing to read it needs attention.
    if (!row) return { key: plane, label, state: plane === 'meta_delivery' ? 'attention' : 'not_measured', detail: absent }
    if (row.state === 'available') return { key: plane, label, state: 'verified', detail: verified }
    const why = blockerLabels(row.blockerCodes.slice(0, 2))
    const state = row.state === 'stale' ? 'not refreshed' : row.state === 'partial' ? 'partial' : 'unavailable'
    return { key: plane, label, state: 'attention', detail: `${label} is ${state}${why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}.` }
  })
  return [...planes, ...UNMEASURED.map((check) => ({ ...check, state: 'not_measured' as const }))]
}

export function readinessSummary(checks: readonly ReadinessCheck[]): { tone: 'ready' | 'neutral' | 'attention'; text: string } {
  const measured = checks.filter((check) => check.state !== 'not_measured')
  const failing = measured.filter((check) => check.state === 'attention')
  const unmeasured = checks.length - measured.length
  if (failing.length > 0) {
    return { tone: 'attention', text: `${failing.length} of ${measured.length} measured ${measured.length === 1 ? 'check needs' : 'checks need'} attention before launch.` }
  }
  if (measured.length === 0) return { tone: 'neutral', text: 'No readiness check could be measured yet.' }
  const rest = unmeasured === 0 ? '' : ` ${unmeasured} more ${unmeasured === 1 ? 'needs' : 'need'} evidence this page does not read.`
  // "Ready" only when nothing is left unmeasured; otherwise the measured checks pass and the line says
  // plainly what is still unread, so a green line never implies a check nobody ran.
  return { tone: 'ready', text: unmeasured === 0
    ? `Ready: all ${measured.length} checks pass.`
    : `${measured.length === 1 ? 'The one measured check passes' : `All ${measured.length} measured checks pass`}.${rest}` }
}

export function GovernedLaunchReadiness({ checks }: { checks: readonly ReadinessCheck[] }) {
  const summary = readinessSummary(checks)
  const Icon = summary.tone === 'attention' ? AlertTriangle : summary.tone === 'ready' ? CheckCircle2 : CircleDashed
  const color = summary.tone === 'ready' ? 'var(--success)' : summary.tone === 'attention' ? 'var(--warning)' : 'var(--text-secondary)'
  return (
    <section aria-label="Governed launch readiness" data-launch-readiness={summary.tone} className="card-base p-4 space-y-3">
      <div>
        <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Governed launch readiness</p>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
          Checklist first, ledger forms second. Unavailable evidence is never shown as a pass or zero.
        </p>
        <p role="status" className="mt-2 flex items-center gap-1.5" style={{ fontSize: '13px', fontWeight: 600, color }}>
          <Icon className="w-4 h-4 shrink-0" aria-hidden />
          {summary.text}
        </p>
      </div>
      <div className="space-y-2">
        {checks.map((item) => (
          <div key={item.key} className="rounded-lg p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between gap-3">
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)' }}>{item.label}</span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: STATE_COPY[item.state].color }}>{STATE_COPY[item.state].label}</span>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>{item.detail}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
