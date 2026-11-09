import type { ReportingData } from './contracts'
import { AUDIENCE_EVIDENCE_LIMIT, audienceConfigurationState, reportAudienceMemberState } from './audience-evidence'
import type { ReportExportRow } from './export'

/** Configuration observations use their own time basis; they are never historical delivery claims. */
export function audienceExportRows(data: ReportingData): ReportExportRow[] {
  return (data.meta?.data?.entities ?? []).filter(entity => entity.level === 'adset').flatMap(entity => {
    const evidence = entity.audienceEvidence
    const base: ReportExportRow = {
      account: `${data.context.account.name ?? 'Meta account'} (${data.context.account.metaAccountId})`,
      entity: `Ad set ${entity.name} (${entity.id}); campaign ${entity.campaignId ?? 'unavailable'}; ${entity.status}`,
      metric: '', value: null, previous_value: null, unit: 'state', source: 'meta_configuration', event: null,
      from: '', to: '', comparison_from: '', comparison_to: '', timezone: data.context.timezone, currency: data.context.currency,
      as_of: evidence?.observedAt ?? '', availability: 'unavailable', coverage: 'unknown', coverage_numerator: null, coverage_denominator: null,
      maturity: 'not_applicable', previous_availability: '', previous_coverage: '', previous_coverage_numerator: null,
      previous_coverage_denominator: null, previous_maturity: '', previous_as_of: '', previous_freshness: '', previous_limitations: '',
      definition: '', date_basis: 'configuration_observation', attribution_scope: 'Current ad-set configuration', freshness: 'unknown',
      limitations: `${AUDIENCE_EVIDENCE_LIMIT} Selected delivery period ${data.context.range.from}–${data.context.range.to}; this observation is not that period's configuration history.`,
    }
    const row = (metric: string, value: string | number | null, definition: string, label = base.entity, unit = 'state'): ReportExportRow => ({
      ...base, entity: label, metric, value, definition, unit, availability: value === null ? 'unavailable' : 'available',
      freshness: evidence ? audienceConfigurationState(evidence, data.context.asOf) : 'unknown',
    })
    if (!evidence) return [row('Audience configuration', null, 'Audience membership and operational evidence were not supplied.')]
    return [
      row('Audience configuration', audienceConfigurationState(evidence, data.context.asOf), 'Availability of current audience references; not historical audience composition.'),
      row('Advantage audience expansion', evidence.expansion, 'Expansion flag returned by current ad-set targeting.'),
      row('Unparsed audience references', evidence.unparsedReferences, 'Malformed references cannot establish an empty audience.', undefined, 'count'),
      ...evidence.members.flatMap(member => {
        const label = `${base.entity}; ${member.role} audience ${member.name ?? 'unnamed'} (${member.id})`
        return [
          row('Audience readiness', reportAudienceMemberState(member, evidence, data.context.asOf), 'Current identity, freshness and native-status checks; not actual reach or efficacy.', label),
          row('Audience subtype', member.subtype, 'Native audience subtype; no inference from name.', label),
          row('Account identity', member.ownership, 'Relationship to the account-scoped inventory; mismatched metadata is withheld.', label),
          row('Operation status', member.operationCode, 'Native operation status code; separate from delivery status.', label, 'native_status_code'),
          row('Delivery status', member.deliveryCode, 'Native delivery status code; cannot substitute for operation status.', label, 'native_status_code'),
          row('Operation status description', member.operationDescription, 'Native Meta status description; not an independent diagnosis.', label),
          row('Delivery status description', member.deliveryDescription, 'Native Meta delivery description, retained separately from operation status.', label),
          row('Approximate size lower bound', member.lowerBound, 'Native approximate lower bound; not an exact member count or saturation denominator.', label, 'count'),
          row('Approximate size upper bound', member.upperBound, 'Native approximate upper bound; missing or negative sentinels remain unavailable.', label, 'count'),
          row('Retention window', member.retentionDays, 'Native retention window when supplied.', label, 'days'),
          row('Seed audience IDs', member.seeds.length ? member.seeds.map(seed => seed.id).join('; ') : null, 'Every supplied explicit lookalike origin ID; no inferred seed membership or quality.', label),
          row('Inventory observed', member.inventoryObservedAt, 'Time the source inventory was observed.', label),
          row('Meta metadata updated', member.metaUpdatedAt, 'Native metadata update time; not proof of a membership refresh.', label),
        ]
      }),
    ]
  })
}
