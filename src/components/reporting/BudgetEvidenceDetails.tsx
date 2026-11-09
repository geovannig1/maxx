import type { ReportEntity } from '@/lib/reporting/contracts'
import { BUDGET_EVIDENCE_LIMIT } from '@/lib/reporting/budget-evidence'
import { budgetContext, formatBudgetAmount } from '@/lib/reporting/budget-presentation'
import { accountTimezone } from '@/config/business-config'

function displayAmount(field: NonNullable<ReportEntity['budgetEvidence']>['dailyBudget'], suffix: string) {
  if (field.state === 'observed') return `${formatBudgetAmount(field.majorUnits)}${suffix}`
  return field.state === 'invalid' ? 'Invalid source value' : 'Not supplied'
}
function displayField(field: { state: 'observed' | 'missing' | 'invalid'; value: string | boolean | null }) {
  if (field.state !== 'observed') return field.state === 'invalid' ? 'Invalid source value' : 'Not supplied'
  return typeof field.value === 'boolean' ? field.value ? 'Enabled' : 'Disabled' : field.value
}
function displayDate(field: NonNullable<ReportEntity['budgetEvidence']>['startTime']) {
  if (field.state !== 'observed') return field.state === 'invalid' ? 'Invalid source value' : 'Not supplied'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: accountTimezone(), timeZoneName: 'short' }).format(new Date(field.value))
}

function Amounts({ evidence }: { evidence: NonNullable<ReportEntity['budgetEvidence']> }) {
  return <><div><dt className="text-xs text-[var(--text-secondary)]">Configured daily budget</dt><dd className="font-medium">{displayAmount(evidence.dailyBudget, ' per day')}</dd></div>
    <div><dt className="text-xs text-[var(--text-secondary)]">Configured lifetime budget</dt><dd className="font-medium">{displayAmount(evidence.lifetimeBudget, ' lifetime')}</dd></div></>
}

export function BudgetContextSummary({ entity, entities }: { entity: ReportEntity; entities: ReportEntity[] }) {
  if (entity.level === 'ad') return null
  const context = budgetContext(entity, entities)
  return <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]"><span className="font-medium text-[var(--text-primary)]">{context.label}</span> · {context.amount}</p>
}

export function BudgetEvidenceDetails({ entity, entities, compact = false }: { entity: ReportEntity; entities: ReportEntity[]; compact?: boolean }) {
  if (entity.level === 'ad') return null
  const own = entity.budgetEvidence, context = budgetContext(entity, entities)
  const parent = context.evidence && context.evidence.entity.id !== entity.id ? context.evidence : null
  if (compact) return <BudgetContextSummary entity={entity} entities={entities} />
  return <section aria-label="Budget and schedule" className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
    <div><h3 className="text-base font-semibold">Budget and schedule</h3>
      <p className="mt-1 text-sm text-[var(--text-secondary)]"><span className="font-medium text-[var(--text-primary)]">{context.label}</span> · {context.amount}</p></div>
    {own ? <><h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Entity configuration</h4>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <Amounts evidence={own} />
      <div><dt className="text-xs text-[var(--text-secondary)]">Current settings observed</dt><dd className="break-words font-medium">{own.observedAt}</dd></div>
      <div><dt className="text-xs text-[var(--text-secondary)]">Configured status</dt><dd className="font-medium">{displayField(own.configuredStatus)}</dd></div>
      <div><dt className="text-xs text-[var(--text-secondary)]">Effective status</dt><dd className="font-medium">{displayField(own.effectiveStatus)}</dd></div>
      <div><dt className="text-xs text-[var(--text-secondary)]">Meta configuration updated</dt><dd className="break-words font-medium">{displayField(own.metaUpdatedAt)}</dd></div>
      <div><dt className="text-xs text-[var(--text-secondary)]">Delivery start</dt><dd className="font-medium">{displayDate(own.startTime)}</dd></div>
      <div><dt className="text-xs text-[var(--text-secondary)]">Delivery end</dt><dd className="font-medium">{displayDate(own.endTime)}</dd></div>
      <div><dt className="text-xs text-[var(--text-secondary)]">Budget schedule</dt><dd className="font-medium">{displayField(own.budgetScheduleEnabled)}</dd></div>
      {entity.level === 'campaign' && <div><dt className="text-xs text-[var(--text-secondary)]">Ad-set budget sharing</dt><dd className="font-medium">{displayField(own.adsetBudgetSharing)}</dd></div>}
    </dl></> : <p className="text-sm text-[var(--text-secondary)]">No validated current budget configuration was supplied for this entity.</p>}
    {parent && <div className="border-t border-[var(--border)] pt-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Parent campaign {parent.entity.id} budget evidence</h4>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3"><Amounts evidence={parent} />
        <div><dt className="text-xs text-[var(--text-secondary)]">Campaign settings observed</dt><dd className="break-words font-medium">{parent.observedAt}</dd></div>
        <div><dt className="text-xs text-[var(--text-secondary)]">Campaign configured status</dt><dd className="font-medium">{displayField(parent.configuredStatus)}</dd></div>
        <div><dt className="text-xs text-[var(--text-secondary)]">Campaign delivery start</dt><dd className="font-medium">{displayDate(parent.startTime)}</dd></div>
        <div><dt className="text-xs text-[var(--text-secondary)]">Campaign delivery end</dt><dd className="font-medium">{displayDate(parent.endTime)}</dd></div>
      </dl></div>}
    <p className="text-xs leading-5 text-[var(--text-secondary)]">{BUDGET_EVIDENCE_LIMIT}</p>
  </section>
}

export function BudgetEvidenceCard({ evidence, label }: { evidence: NonNullable<ReportEntity['budgetEvidence']>; label: string }) {
  return <div className="mt-3 rounded-lg border border-[var(--border)] p-3 text-xs leading-5 print:break-inside-avoid">
    <p className="break-words font-medium text-[var(--text-primary)]">{label}</p>
    <p>Daily: {displayAmount(evidence.dailyBudget, ' per day')} · Lifetime: {displayAmount(evidence.lifetimeBudget, ' lifetime')}</p>
    <p>Configured status: {displayField(evidence.configuredStatus)} · Effective status: {displayField(evidence.effectiveStatus)}</p>
    <p>Delivery dates: {displayDate(evidence.startTime)} – {displayDate(evidence.endTime)}</p>
    <p className="break-words">Current settings observed {evidence.observedAt}</p>
  </div>
}
