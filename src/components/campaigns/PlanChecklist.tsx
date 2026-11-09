import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react'
import type { ReadinessItem } from '@/lib/campaigns/plan-readiness'
import type { PlanIssue } from '@/lib/campaigns/plan-validation'

// ADR-062: a plan's launch-readiness checklist and its validation findings. Presentational only.

const ICON = { ok: CheckCircle2, warn: AlertTriangle, blocked: XCircle, unknown: HelpCircle } as const
const COLOR = { ok: 'var(--success)', warn: 'var(--warning)', blocked: 'var(--danger)', unknown: 'var(--text-tertiary)' } as const

export function PlanReadinessList({ items }: { items: readonly ReadinessItem[] }) {
  return (
    <section className="card-base p-4" aria-labelledby="plan-readiness-title" data-plan-readiness>
      <h2 id="plan-readiness-title" className="text-[14px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Launch readiness</h2>
      <ul className="space-y-2">
        {items.map((item) => {
          const Icon = ICON[item.status]
          return (
            <li key={item.id} data-readiness={item.id} data-status={item.status} className="flex gap-2 text-[12.5px]">
              <Icon size={15} style={{ color: COLOR[item.status], flexShrink: 0, marginTop: 2 }} aria-hidden />
              <span><b style={{ color: 'var(--text-primary)' }}>{item.label}</b> <span className="sr-only">({item.status})</span><br /><span style={{ color: 'var(--text-secondary)' }}>{item.detail}</span></span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function PlanIssueList({ issues }: { issues: readonly PlanIssue[] }) {
  if (issues.length === 0) return <p className="text-[12.5px]" style={{ color: 'var(--success)' }} data-plan-valid>No blocker or warning: this version can be submitted.</p>
  return (
    <ul className="space-y-1" aria-label="Validation findings" data-plan-issues>
      {issues.map((issue, i) => (
        <li key={i} className="text-[12px]" style={{ color: issue.severity === 'blocker' ? 'var(--danger)' : 'var(--warning)' }}>
          <b>{issue.severity === 'blocker' ? 'Blocker' : 'Warning'}</b> · {issue.path}: {issue.message}
        </li>
      ))}
    </ul>
  )
}

/** Findings for one field (and its children), shown under the field. */
export function FieldIssues({ issues, path, exact = false }: { issues: readonly PlanIssue[]; path: string; exact?: boolean }) {
  const mine = issues.filter((i) => i.path === path || (!exact && i.path.startsWith(`${path}.`)))
  if (mine.length === 0) return null
  return (
    <span role="note" className="text-[11.5px]" style={{ color: mine.some((i) => i.severity === 'blocker') ? 'var(--danger)' : 'var(--warning)' }}>
      {mine.map((i) => i.message).join(' ')}
    </span>
  )
}
