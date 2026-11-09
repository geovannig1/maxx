import { BUDGET_EVIDENCE_LIMIT, resolveBudgetOwnership, type ReportBudgetEvidence } from './budget-evidence'
import type { ReportEntity, ReportingContext } from './contracts'
import type { ReportExportRow } from './export'
import { configuredBudgetText } from './budget-presentation'

function row(context: ReportingContext, entity: ReportEntity, evidence: ReportBudgetEvidence, input: {
  metric: string; value: string | number | null; availability: string; definition: string; unit?: string
}): ReportExportRow {
  return {
    account: `${context.account.name ?? 'Meta account'} (${context.account.metaAccountId})`,
    entity: `${entity.name} (${entity.level} ${entity.id})`,
    metric: input.metric, value: input.value, previous_value: null, unit: input.unit ?? (typeof input.value === 'number' ? 'money' : 'configuration'),
    source: 'meta_configuration', event: null, from: '', to: '', comparison_from: '', comparison_to: '',
    timezone: context.timezone, currency: context.currency, as_of: evidence.observedAt,
    availability: input.availability, coverage: 'not_applicable', coverage_numerator: null, coverage_denominator: null,
    maturity: 'current_configuration', previous_availability: '', previous_coverage: '', previous_coverage_numerator: null,
    previous_coverage_denominator: null, previous_maturity: '', previous_as_of: '', previous_freshness: '', previous_limitations: '',
    definition: input.definition, date_basis: 'configuration_observation', attribution_scope: 'not_applicable',
    freshness: evidence.observedAt === context.asOf ? 'current' : 'observed', limitations: BUDGET_EVIDENCE_LIMIT,
    claim_id: null, input_claim_ids: null, previous_claim_id: null, previous_input_claim_ids: null,
  }
}

function fieldValue<T>(field: { state: 'observed' | 'missing' | 'invalid'; value: T | null }) {
  return field.state === 'observed' ? field.value : null
}
function flagValue(field: { state: 'observed' | 'missing' | 'invalid'; value: boolean | null }) {
  return field.state === 'observed' ? field.value ? 'enabled' : 'disabled' : null
}

export function budgetExportRows(entities: ReportEntity[], allEntities: ReportEntity[], context: ReportingContext): ReportExportRow[] {
  return entities.flatMap(entity => {
    const evidence = entity.budgetEvidence
    if (!evidence || entity.level === 'ad') return []
    const ownership = resolveBudgetOwnership(entity, allEntities)
    const ownAmount = configuredBudgetText(evidence)
    const owner = ownership.state === 'campaign' && ownership.owner
      ? `Campaign ${ownership.owner.entity.id} · ${configuredBudgetText(ownership.owner)}`
      : ownership.state === 'own' && ownership.owner
        ? `${entity.level === 'campaign' ? 'Campaign' : 'Ad set'} ${entity.id} · ${configuredBudgetText(ownership.owner)}`
        : ownership.state === 'undetermined' && ownership.parent
          ? ownAmount !== 'amount unavailable'
            ? `Undetermined · Ad set ${ownAmount} · Campaign ${ownership.parent.entity.id} ${configuredBudgetText(ownership.parent)}`
            : `Campaign ${ownership.parent.entity.id} · ${configuredBudgetText(ownership.parent)} · ad-set budget ownership not established`
          : ownership.state === 'undetermined' ? 'Undetermined from current campaign and ad-set fields' : 'Unavailable'
    const amount = (metric: string, value: ReportBudgetEvidence['dailyBudget'], definition: string) => row(context, entity, evidence, {
      metric, value: value.state === 'observed' ? value.majorUnits : null, availability: value.state, definition, unit: 'money',
    })
    return [
      amount('Configured daily budget', evidence.dailyBudget, "Native configured daily budget normalized once from the account currency's minor units; it is an average, not a hard daily cap."),
      amount('Configured lifetime budget', evidence.lifetimeBudget, "Native configured lifetime budget normalized once from the account currency's minor units."),
      row(context, entity, evidence, { metric: 'Budget owner', value: owner, availability: ownership.state,
        definition: 'Current budget ownership is resolved from the entity and its exact parent campaign without assigning a campaign amount to an ad set.' }),
      row(context, entity, evidence, { metric: 'Configured status', value: fieldValue(evidence.configuredStatus), availability: evidence.configuredStatus.state,
        definition: 'Native Meta status observed with the current configuration.' }),
      row(context, entity, evidence, { metric: 'Effective status', value: fieldValue(evidence.effectiveStatus), availability: evidence.effectiveStatus.state,
        definition: 'Native Meta effective_status observed with the current configuration.' }),
      row(context, entity, evidence, { metric: 'Delivery start', value: fieldValue(evidence.startTime), availability: evidence.startTime.state,
        definition: 'Current outer delivery start time; detailed schedules are not included.' }),
      row(context, entity, evidence, { metric: 'Delivery end', value: fieldValue(evidence.endTime), availability: evidence.endTime.state,
        definition: 'Current outer delivery stop/end time; detailed schedules are not included.' }),
      row(context, entity, evidence, { metric: 'Meta configuration updated', value: fieldValue(evidence.metaUpdatedAt), availability: evidence.metaUpdatedAt.state,
        definition: 'Native Meta updated_time when supplied.' }),
      row(context, entity, evidence, { metric: 'Ad-set budget sharing enabled', value: flagValue(evidence.adsetBudgetSharing), availability: evidence.adsetBudgetSharing.state,
        definition: 'Native campaign-level ad-set budget sharing flag when supplied.' }),
      row(context, entity, evidence, { metric: 'Budget schedule enabled', value: flagValue(evidence.budgetScheduleEnabled), availability: evidence.budgetScheduleEnabled.state,
        definition: 'Native budget schedule flag when supplied; schedule details are outside this evidence.' }),
    ]
  })
}
