import type { ReportEntity } from './contracts'
import type { ReportBudgetEvidence } from './budget-evidence'
import { resolveBudgetOwnership } from './budget-evidence'
import { formatMoneyAmount } from '@/lib/utils/format-currency'

export function formatBudgetAmount(value: number): string {
  return `${formatMoneyAmount(value)}`
}

export function configuredBudgetText(evidence: ReportBudgetEvidence): string {
  const daily = evidence.dailyBudget.state === 'observed' && evidence.dailyBudget.minorUnits > 0
    ? `${formatBudgetAmount(evidence.dailyBudget.majorUnits)} per day` : null
  const lifetime = evidence.lifetimeBudget.state === 'observed' && evidence.lifetimeBudget.minorUnits > 0
    ? `${formatBudgetAmount(evidence.lifetimeBudget.majorUnits)} lifetime` : null
  return [daily, lifetime].filter(Boolean).join(' and ') || 'amount unavailable'
}

export function budgetContext(entity: ReportEntity, entities: ReportEntity[]): {
  label: string; amount: string; evidence: ReportBudgetEvidence | null
} {
  if (entity.level === 'ad') return { label: 'Budget context', amount: 'Available at ad-set or campaign level', evidence: null }
  const ownership = resolveBudgetOwnership(entity, entities)
  if (ownership.state === 'campaign' && ownership.owner) return {
    label: `Campaign budget · current observation · Campaign ${ownership.owner.entity.id}`,
    amount: configuredBudgetText(ownership.owner), evidence: ownership.owner,
  }
  if (ownership.state === 'own' && ownership.owner) return {
    label: entity.level === 'campaign' ? 'Configured budget · current observation' : 'Ad-set budget · current observation',
    amount: configuredBudgetText(ownership.owner), evidence: ownership.owner,
  }
  if (ownership.state === 'undetermined' && ownership.parent) return {
    label: entity.budgetEvidence && configuredBudgetText(entity.budgetEvidence) !== 'amount unavailable'
      ? 'Budget ownership undetermined · current observation' : `Campaign budget context · current observation · Campaign ${ownership.parent.entity.id}`,
    amount: entity.budgetEvidence && configuredBudgetText(entity.budgetEvidence) !== 'amount unavailable'
      ? `Ad set ${configuredBudgetText(entity.budgetEvidence)} · Campaign ${ownership.parent.entity.id} ${configuredBudgetText(ownership.parent)}`
      : `${configuredBudgetText(ownership.parent)} · ad-set budget ownership not established`, evidence: ownership.parent,
  }
  return { label: ownership.state === 'undetermined' ? 'Budget ownership undetermined' : 'Budget unavailable',
    amount: ownership.state === 'undetermined' ? 'Inspect the current campaign and ad-set fields' : 'No positive configured amount was established',
    evidence: null }
}
