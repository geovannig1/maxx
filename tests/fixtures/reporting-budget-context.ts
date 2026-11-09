import { projectBudgetEvidence } from '@/lib/reporting/budget-evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { purchaseCpaFixture } from './reporting-purchase-cpa'

export function budgetContextFixture() {
  const data = purchaseCpaFixture()
  const rows = data.meta.data!.entities
  const source = {
    'campaign:101': { id: '101', account_id: data.context.account.metaAccountId, status: 'PAUSED', effective_status: 'PAUSED',
      daily_budget: '10000', start_time: '2026-08-01T00:00:00-0400', stop_time: '2026-10-01T00:00:00-0400',
      updated_time: '2026-09-05T12:00:00Z', is_adset_budget_sharing_enabled: false, is_budget_schedule_enabled: false },
    'campaign:102': { id: '102', account_id: data.context.account.metaAccountId, status: 'ACTIVE', effective_status: 'ACTIVE' },
    'adset:201': { id: '201', account_id: data.context.account.metaAccountId, campaign_id: '101', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED',
      start_time: '2026-08-02T00:00:00-0400', end_time: '2026-09-30T00:00:00-0400',
      updated_time: '2026-09-05T13:00:00Z', is_budget_schedule_enabled: true },
    'adset:202': { id: '202', account_id: data.context.account.metaAccountId, campaign_id: '102', status: 'ACTIVE', effective_status: 'ACTIVE',
      daily_budget: '4000', updated_time: '2026-09-05T13:00:00Z' },
  } as const
  for (const entity of rows) {
    if (entity.level === 'ad') continue
    entity.configurationAsOf = data.context.asOf
    const key = `${entity.level}:${entity.id}` as keyof typeof source
    entity.budgetEvidence = projectBudgetEvidence(data.context,
      { level: entity.level, id: entity.id, campaignId: entity.campaignId }, source[key], data.context.asOf)
  }
  validateReportingPacket({ section: 'meta', context: data.context, result: data.meta, notes: [] })
  return data
}
