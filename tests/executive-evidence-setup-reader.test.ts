import { describe, expect, it } from 'vitest'
import {
  applyApprovedComparisonRoles,
  projectAdSetupDecisionMaterialChangeForExecutive,
  readExecutiveSetupEvidenceV1,
} from '@/lib/report/executive-evidence-setup-reader'
import {
  quarantineFailedSetupSources,
  validateSetupGeneration,
} from '@/lib/report/executive-evidence-setup-health'
import {
  buildMetaSetupGenerationFingerprint,
  sha256Fingerprint,
  type NormalizedMetaSetupSnapshotV1,
} from '@/lib/setup-history'
import type { SupabaseClient } from '@supabase/supabase-js'

const AS_OF = '2026-08-16T12:00:00.000Z'
const ACCOUNT = '00000000-0000-4000-8000-000000000301'
const GENERATION = '00000000-0000-4000-8000-000000000302'

function adsets() {
  return [
    { adset_id: 'cold-id', adset_name: 'Cold' },
    { adset_id: 'warm-id', adset_name: 'Warm' },
  ]
}

describe('executive setup reader material-change governance', () => {
  it('fails closed on contradictory ad_setup_decisions rows', () => {
    expect(
      projectAdSetupDecisionMaterialChangeForExecutive({
        id: '00000000-0000-4000-8000-000000000301',
        action_taken: false,
        user_decision: 'needs_more_data',
        action_taken_date: null,
        decision_date: '2026-08-10T12:00:00.000Z',
        created_at: '2026-08-10T12:00:00.000Z',
        reason: 'Claimed 4/4 tags',
        setting_category: 'utm',
        entity_key: 'adset-1',
        final_value: '4/4 tags',
        actual_launched_value: '4/4 tags',
      }),
    ).toEqual({
      status: 'unknown',
      occurredAt: '2026-08-10T12:00:00.000Z',
      reasonCode: 'setup_change_reason_unknown',
    })
  })

  it('emits known only with confirmed executed-decision evidence', () => {
    expect(
      projectAdSetupDecisionMaterialChangeForExecutive({
        id: '00000000-0000-4000-8000-000000000302',
        action_taken: true,
        user_decision: 'acted_on',
        action_taken_date: '2026-08-10T14:00:00.000Z',
        decision_date: '2026-08-10T12:00:00.000Z',
        created_at: '2026-08-10T12:00:00.000Z',
        reason: 'Owner executed UTM tag update',
        setting_category: 'utm',
        entity_key: 'adset-1',
        final_value: 'utm_campaign=cold',
        actual_launched_value: 'utm_campaign=cold',
      }),
    ).toEqual({
      status: 'known',
      governanceBasis: 'confirmed_executed_decision',
      materialChangeId: '00000000-0000-4000-8000-000000000302',
      materialChangeIds: ['00000000-0000-4000-8000-000000000302'],
      occurredAt: '2026-08-10T14:00:00.000Z',
      reason: 'Owner executed UTM tag update',
      source: 'ad_setup_decisions',
      settingCategories: ['utm'],
      affectedMetaIds: ['adset-1'],
    })
  })
})

describe('executive setup reader comparison-role governance', () => {
  it('binds one Cold and one Warm role from the latest approved owner declaration', () => {
    const result = applyApprovedComparisonRoles(adsets(), [{
      source_kind: 'owner_declared',
      approved_at: '2026-08-15T12:00:00.000Z',
      approved_by: 'owner@example.com',
      plan: {
        comparison_roles: [
          { meta_adset_id: 'cold-id', role: 'cold' },
          { meta_adset_id: 'warm-id', role: 'warm' },
        ],
      },
    }], AS_OF)

    expect(result).toEqual([
      expect.objectContaining({
        adset_id: 'cold-id', comparison_role: 'cold', comparison_role_source: 'owner_declared',
      }),
      expect.objectContaining({
        adset_id: 'warm-id', comparison_role: 'warm', comparison_role_source: 'owner_declared',
      }),
    ])
  })

  it.each([
    {
      label: 'a future approval',
      row: {
        source_kind: 'owner_declared', approved_at: '2026-08-17T12:00:00.000Z', approved_by: 'owner',
        plan: { comparison_roles: [
          { meta_adset_id: 'cold-id', role: 'cold' }, { meta_adset_id: 'warm-id', role: 'warm' },
        ] },
      },
    },
    {
      label: 'an unsupported source',
      row: {
        source_kind: 'model_inferred', approved_at: '2026-08-15T12:00:00.000Z', approved_by: 'owner',
        plan: { comparison_roles: [
          { meta_adset_id: 'cold-id', role: 'cold' }, { meta_adset_id: 'warm-id', role: 'warm' },
        ] },
      },
    },
    {
      label: 'duplicate role declarations',
      row: {
        source_kind: 'campaign_plan', approved_at: '2026-08-15T12:00:00.000Z', approved_by: 'owner',
        plan: { comparison_roles: [
          { meta_adset_id: 'cold-id', role: 'cold' }, { meta_adset_id: 'warm-id', role: 'cold' },
        ] },
      },
    },
    {
      label: 'a missing approver',
      row: {
        source_kind: 'campaign_plan', approved_at: '2026-08-15T12:00:00.000Z', approved_by: ' ',
        plan: { comparison_roles: [
          { meta_adset_id: 'cold-id', role: 'cold' }, { meta_adset_id: 'warm-id', role: 'warm' },
        ] },
      },
    },
  ])('fails closed for $label', ({ row }) => {
    expect(applyApprovedComparisonRoles(adsets(), [row], AS_OF)).toEqual([
      expect.objectContaining({ comparison_role: null, comparison_role_source: null }),
      expect.objectContaining({ comparison_role: null, comparison_role_source: null }),
    ])
  })

  it('skips unrelated newer plans but does not skip an invalid newer role declaration', () => {
    const valid = {
      source_kind: 'campaign_plan', approved_at: '2026-08-14T12:00:00.000Z', approved_by: 'owner',
      plan: { comparison_roles: [
        { meta_adset_id: 'cold-id', role: 'cold' }, { meta_adset_id: 'warm-id', role: 'warm' },
      ] },
    }
    expect(applyApprovedComparisonRoles(adsets(), [
      { source_kind: 'owner_declared', approved_at: '2026-08-15T12:00:00.000Z', approved_by: 'owner', plan: {} },
      valid,
    ], AS_OF)[0]).toMatchObject({ comparison_role: 'cold', comparison_role_source: 'campaign_plan' })

    expect(applyApprovedComparisonRoles(adsets(), [
      {
        source_kind: 'owner_declared', approved_at: '2026-08-15T12:00:00.000Z', approved_by: 'owner',
        plan: { comparison_roles: [{ meta_adset_id: 'cold-id', role: 'cold' }] },
      },
      valid,
    ], AS_OF).every((row) => row.comparison_role === null)).toBe(true)
  })
})

describe('executive setup reader current-run source boundary', () => {
  it('rejects a prior setup generation when the current run failed to commit one', () => {
    expect(validateSetupGeneration({
      id: 'old-generation', observed_at: AS_OF, complete: true, blocker_codes: [],
    }, AS_OF, null)).toEqual({
      head: AS_OF,
      blockerCodes: ['setup_generation_current_run_mismatch'],
      blocksAll: true,
    })
  })

  it('quarantines cached audience and creative rows after current-run source failures', () => {
    const result = quarantineFailedSetupSources({
      audience_inventory: {
        read_available: true, schema: 'rich', row_count: 1, reason_code: null, reason: null,
      },
      audiences_by_id: {
        stale: { id: 'stale', name: 'Stale audience', subtype: 'WEBSITE', accountId: 'act_1' },
      },
    }, [{ creative_id: 'stale-creative' }], [
      'custom_audience_sync_failed', 'creative_sync_failed',
    ])

    expect(result.audience.audience_inventory).toMatchObject({ read_available: false })
    expect(result.audience.audiences_by_id).toEqual({})
    expect(result.creativeRows).toEqual([])
  })

  it('keeps the generation partial when an exact current generation records source blockers', () => {
    expect(validateSetupGeneration({
      id: 'current-generation', observed_at: AS_OF, complete: false,
      blocker_codes: ['creative_inventory_incomplete'],
    }, AS_OF, 'current-generation')).toEqual({
      head: AS_OF,
      blockerCodes: ['creative_inventory_incomplete'],
      blocksAll: false,
    })
  })
})

type FakeRow = Record<string, unknown>

class SetupReaderQuery implements PromiseLike<{ data: FakeRow[]; error: null }> {
  private readonly filters: Array<(row: FakeRow) => boolean> = []
  private readonly orders: Array<{ column: string; ascending: boolean }> = []
  private rowLimit: number | null = null
  private rowRange: { from: number; to: number } | null = null

  constructor(
    private readonly table: string,
    private readonly rows: FakeRow[],
    private readonly calls: string[],
  ) {}

  select() {
    this.calls.push(this.table)
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value)
    return this
  }

  lte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column] ?? '') <= String(value ?? ''))
    return this
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: options.ascending !== false })
    return this
  }

  limit(count: number) {
    this.rowLimit = count
    return this
  }

  range(from: number, to: number) {
    this.rowRange = { from, to }
    return this
  }

  async maybeSingle() {
    const data = this.result()
    return { data: data[0] ?? null, error: null }
  }

  then<TResult1 = { data: FakeRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: FakeRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.result(), error: null }).then(onfulfilled, onrejected)
  }

  private result(): FakeRow[] {
    let result = this.rows.filter((row) => this.filters.every((filter) => filter(row)))
    for (const order of [...this.orders].reverse()) {
      result = [...result].sort((left, right) => {
        const comparison = String(left[order.column] ?? '').localeCompare(String(right[order.column] ?? ''))
        return order.ascending ? comparison : -comparison
      })
    }
    if (this.rowRange) result = result.slice(this.rowRange.from, this.rowRange.to + 1)
    if (this.rowLimit !== null) result = result.slice(0, this.rowLimit)
    return result
  }
}

function setupReaderDb(rows: Record<string, FakeRow[]>) {
  const calls: string[] = []
  return {
    calls,
    client: {
      from(table: string) {
        return new SetupReaderQuery(table, rows[table] ?? [], calls)
      },
    } as unknown as SupabaseClient,
  }
}

function campaignSnapshot(metaId = 'current-campaign'): NormalizedMetaSetupSnapshotV1 {
  const config = {
    campaign_name: 'Current campaign', objective: 'OUTCOME_SALES', status: 'ACTIVE',
    effective_status: 'ACTIVE', buying_type: 'AUCTION', special_ad_category: 'NONE',
    daily_budget: 50, lifetime_budget: null, start_time: null, stop_time: null,
  }
  return {
    contract_version: 1,
    entity_level: 'campaign',
    entity_db_id: '00000000-0000-4000-8000-000000000303',
    meta_entity_id: metaId,
    parent_meta_ids: {},
    config,
    config_fingerprint: sha256Fingerprint(config),
    observed_synced_at: AS_OF,
  }
}

function setupGenerationRows(
  snapshots: NormalizedMetaSetupSnapshotV1[],
  overrides: Record<string, unknown> = {},
): Record<string, FakeRow[]> {
  return {
    ad_accounts: [{ id: ACCOUNT, account_id: '1234567890', is_active: true }],
    meta_setup_generations: [{
      id: GENERATION,
      ad_account_id: ACCOUNT,
      observed_at: AS_OF,
      complete: true,
      blocker_codes: [],
      entity_count: snapshots.length,
      generation_fingerprint: buildMetaSetupGenerationFingerprint(snapshots),
      ...overrides,
    }],
    meta_setup_entity_snapshots: snapshots.map((snapshot, index) => ({
      id: `00000000-0000-4000-8000-${String(400 + index).padStart(12, '0')}`,
      generation_id: GENERATION,
      ad_account_id: ACCOUNT,
      ...snapshot,
    })),
    setup_material_changes: [],
    ad_setup_decisions: [],
    setup_change_plans: [],
    campaigns: [{
      id: '00000000-0000-4000-8000-000000000399',
      ad_account_id: ACCOUNT,
      campaign_id: 'retained-stale-campaign',
      campaign_name: 'Retained stale campaign',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      last_synced_at: '2026-08-16T11:59:59.000Z',
    }],
  }
}

describe('executive setup reader immutable generation binding', () => {
  it('cannot reintroduce a retained mutable entity absent from the exact generation snapshots', async () => {
    const snapshot = campaignSnapshot()
    const db = setupReaderDb(setupGenerationRows([snapshot]))

    const result = await readExecutiveSetupEvidenceV1(db.client, {
      accountId: ACCOUNT,
      timezone: 'America/New_York',
      asOf: AS_OF,
      lastCompleteDate: '2026-08-15',
    }, { currentRunSetupGenerationId: GENERATION })

    expect(result.data?.campaigns.map((campaign) => campaign.meta_campaign_id)).toEqual(['current-campaign'])
    expect(db.calls).not.toContain('campaigns')
    expect(db.calls).toContain('meta_setup_entity_snapshots')
  })

  it('fails closed when the exact generation snapshot count does not match its header', async () => {
    const rows = setupGenerationRows([campaignSnapshot()], { entity_count: 2 })
    const db = setupReaderDb(rows)

    await expect(readExecutiveSetupEvidenceV1(db.client, {
      accountId: ACCOUNT,
      timezone: 'America/New_York',
      asOf: AS_OF,
      lastCompleteDate: '2026-08-15',
    }, { currentRunSetupGenerationId: GENERATION })).rejects.toThrow(/snapshot count mismatch/i)
  })

  it('fails closed when the exact generation fingerprint does not match its snapshots', async () => {
    const rows = setupGenerationRows([campaignSnapshot()], {
      generation_fingerprint: `sha256:${'0'.repeat(64)}`,
    })
    const db = setupReaderDb(rows)

    await expect(readExecutiveSetupEvidenceV1(db.client, {
      accountId: ACCOUNT,
      timezone: 'America/New_York',
      asOf: AS_OF,
      lastCompleteDate: '2026-08-15',
    }, { currentRunSetupGenerationId: GENERATION })).rejects.toThrow(/generation fingerprint mismatch/i)
  })

  it('fails closed when immutable snapshot config no longer matches its own fingerprint', async () => {
    const snapshot = campaignSnapshot()
    const rows = setupGenerationRows([snapshot])
    rows.meta_setup_entity_snapshots[0] = {
      ...rows.meta_setup_entity_snapshots[0],
      config: { ...snapshot.config, daily_budget: 500 },
    }
    const db = setupReaderDb(rows)

    await expect(readExecutiveSetupEvidenceV1(db.client, {
      accountId: ACCOUNT,
      timezone: 'America/New_York',
      asOf: AS_OF,
      lastCompleteDate: '2026-08-15',
    }, { currentRunSetupGenerationId: GENERATION })).rejects.toThrow(/config fingerprint mismatch/i)
  })
})
