import { metaGetPaginated, unsupportedOptionalMetaField } from './client'
import type { MetaCustomAudience } from '@/types/meta-api'

// Ownership comes from the account-scoped endpoint itself. account_id is useful enrichment but some
// Graph permissions reject it, so it must never take the entire audience inventory offline.
const REQUIRED_FIELDS = ['id', 'name', 'subtype']
const OPTIONAL_FIELDS = [
  'account_id',
  'approximate_count',
  'approximate_count_lower_bound',
  'approximate_count_upper_bound',
  'retention_days',
  'lookalike_spec',
  'operation_status',
  'delivery_status',
  'time_updated',
]

function fields(optional: Set<string>): string {
  return [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS.filter((field) => optional.has(field))].join(',')
}

/** Fetch account-scoped audience definitions used by targeting composition diagnostics. */
export async function fetchCustomAudiences<T = MetaCustomAudience>(accountId: string,
  pages: (path: string, params: Record<string, string>) => Promise<T[]> = metaGetPaginated<T>,
): Promise<T[]> {
  const normalizedAccountId = accountId.replace(/^act_/, '')
  const optional = new Set(OPTIONAL_FIELDS)
  while (true) {
    try {
      return await pages(
        `/act_${normalizedAccountId}/customaudiences`,
        { fields: fields(optional), limit: '200' },
      )
    } catch (error) {
      const unsupported = unsupportedOptionalMetaField(error, optional)
      if (!unsupported) throw error
      optional.delete(unsupported)
      console.warn(`[Sync] Meta did not expose custom-audience field ${unsupported}; retrying without it`)
    }
  }
}
