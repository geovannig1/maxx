import { describe, expect, it } from 'vitest'
import { resolveEconomicsPolicyRows } from '@/lib/economics/economics-policy-reader'

const HASH = `sha256:${'a'.repeat(64)}`
const approval = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000175',
  artifact_id: '00000000-0000-4000-8000-000000000075',
  artifact_hash: HASH,
  decision: 'approved',
  revision: 1,
  effective_from: '2026-08-01T00:00:00Z',
  review_due_at: '2026-12-01T00:00:00Z',
  created_at: '2026-08-02T00:00:00Z',
  ...over,
})
const policy = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000075',
  schema_version: 1,
  objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
  currency: 'USD',
  processor: 'unknown_processor',
  processor_account_ref: 'merchant_1',
  realization_horizon_days: 30,
  variable_cost_basis: 'outcome_actual_entries',
  required_cost_sources: ['owner_actual_cost_export'],
  allowed_variable_cost_categories: ['consumables', 'provider_commission'],
  variable_cost_category_sources: {
    consumables: 'owner_actual_cost_export',
    provider_commission: 'owner_actual_cost_export',
  },
  fixed_overhead_treatment: 'excluded_from_contribution',
  content_hash: HASH,
  captured_at: '2026-08-02T00:00:00Z',
  ...over,
})

const input = (over: Record<string, unknown> = {}) => ({
  approval: approval(),
  artifact: policy(),
  windowStart: '2026-08-05T00:00:00Z',
  asOf: '2026-08-10T00:00:00Z',
  ...over,
})

describe('governed economics policy resolution', () => {
  it('returns only the exact approved processor and actual-cost contract', () => {
    const result = resolveEconomicsPolicyRows(input())
    expect(result).toMatchObject({
      status: 'available',
      approvalId: '00000000-0000-4000-8000-000000000175',
      policyId: '00000000-0000-4000-8000-000000000075',
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      settlementSource: { processor: 'unknown_processor', processorAccountRef: 'merchant_1' },
      realizationHorizonDays: 30,
      requiredCostSources: ['owner_actual_cost_export'],
      allowedVariableCostCategories: ['consumables', 'provider_commission'],
      variableCostCategorySources: {
        consumables: 'owner_actual_cost_export',
        provider_commission: 'owner_actual_cost_export',
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/gross.margin|roas|booked.value/i)
  })

  it('fails closed when approval is absent or withdrawn', () => {
    expect(resolveEconomicsPolicyRows(input({ approval: null, artifact: null })))
      .toEqual({ status: 'unavailable', blockerCodes: ['economics_policy_missing'] })
    expect(resolveEconomicsPolicyRows(input({
      approval: approval({ decision: 'withdrawn', effective_from: null, review_due_at: null }),
      artifact: null,
    }))).toEqual({ status: 'unavailable', blockerCodes: ['economics_policy_withdrawn'] })
  })

  it('fails closed when the policy is not yet effective or owner review has expired', () => {
    expect(resolveEconomicsPolicyRows(input({
      approval: approval({ effective_from: '2026-08-06T00:00:00Z' }),
    }))).toEqual({ status: 'unavailable', blockerCodes: ['economics_policy_not_effective'] })
    expect(resolveEconomicsPolicyRows(input({
      approval: approval({ review_due_at: '2026-08-09T00:00:00Z' }),
    }))).toEqual({ status: 'unavailable', blockerCodes: ['economics_policy_review_expired'] })
  })

  it('fails closed on a missing artifact but rejects contradictory stored authority', () => {
    expect(resolveEconomicsPolicyRows(input({ artifact: null }))).toEqual({
      status: 'unavailable', blockerCodes: ['economics_policy_artifact_missing'],
    })
    expect(() => resolveEconomicsPolicyRows(input({ artifact: policy({ content_hash: `sha256:${'b'.repeat(64)}` }) })))
      .toThrow(/hash mismatch/i)
    expect(() => resolveEconomicsPolicyRows(input({ artifact: policy({ currency: 'EUR' }) })))
      .toThrow(/malformed economics policy/i)
  })

  it('rejects approval rows created after the declared as-of cut', () => {
    expect(() => resolveEconomicsPolicyRows(input({
      approval: approval({ created_at: '2026-08-11T00:00:00Z' }),
    }))).toThrow(/after the as-of/i)
    expect(() => resolveEconomicsPolicyRows(input({
      windowStart: '2026-08-11T00:00:00Z',
    }))).toThrow(/as-of precedes/i)
  })
})
