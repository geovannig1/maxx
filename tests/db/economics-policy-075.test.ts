import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000075'
const OTHER = '00000000-0000-4000-8000-000000000076'
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const FUTURE_REVIEW = new Date(Date.now() + 365 * 86_400_000).toISOString()
let db: PGlite

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

async function commitPolicy(over: Record<string, unknown> = {}) {
  const args = {
    account: ACCOUNT,
    processor: 'unknown_processor',
    processorAccountRef: 'merchant_1',
    horizon: 30,
    costSources: ['owner_actual_cost_export'],
    categories: ['consumables', 'provider_commission'],
    hash: HASH_A,
    sourceRef: 'owner-approved economics worksheet v1',
    capturedAt: '2026-08-02T12:00:00Z',
    dedupe: 'economics-policy-v1',
    ...over,
  }
  // The shipped RPC requires each category to name the one required source that owns it.
  const categorySources = Object.fromEntries(args.categories.map((category) => [category, args.costSources[0]]))
  return one<Record<string, unknown>>(`
    SELECT (public.commit_economics_policy_version(
      $1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      'USD',$2,$3,$4,'outcome_actual_entries',$5::text[],$6::text[],$11::jsonb,
      'excluded_from_contribution',$7,'owner_entry',$8,$9::timestamptz,$10
    )).*`, [
    args.account, args.processor, args.processorAccountRef, args.horizon,
    args.costSources, args.categories, args.hash, args.sourceRef, args.capturedAt, args.dedupe,
    JSON.stringify(categorySources),
  ])
}

async function approvePolicy(
  artifactId: string,
  expectedPrevious: string | null = null,
  over: Record<string, unknown> = {},
) {
  const args = {
    account: ACCOUNT,
    hash: HASH_A,
    effectiveFrom: '2026-08-01T00:00:00Z',
    reviewedBy: 'owner',
    reason: 'Verified processor identity and actual variable-cost sources.',
    reviewDueAt: FUTURE_REVIEW,
    dedupe: 'approve-economics-v1',
    ...over,
  }
  return one<Record<string, unknown>>(`
    SELECT (public.approve_economics_policy_version(
      $1,$2,$3,$4,$5::timestamptz,$6,$7,$8::timestamptz,$9
    )).*`, [
    args.account, artifactId, args.hash, expectedPrevious, args.effectiveFrom,
    args.reviewedBy, args.reason, args.reviewDueAt, args.dedupe,
  ])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER)
  await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [OTHER])
})

describe('governed economics policy', () => {
  it('commits one exact policy idempotently and rejects a dedupe collision', async () => {
    const first = await commitPolicy()
    const retry = await commitPolicy()
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      revision: 1,
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      currency: 'USD',
      variable_cost_basis: 'outcome_actual_entries',
      fixed_overhead_treatment: 'excluded_from_contribution',
    })
    await expect(commitPolicy({ hash: HASH_B })).rejects.toThrow(/dedupe collision/i)
  })

  it('rejects empty, duplicate, malformed, and estimate-based cost inputs', async () => {
    await expect(commitPolicy({ costSources: [] })).rejects.toThrow(/required_cost_sources|check constraint/i)
    await expect(commitPolicy({ costSources: ['actual_export', 'actual_export'] }))
      .rejects.toThrow(/required_cost_sources|check constraint/i)
    await expect(commitPolicy({ categories: ['provider_commission', 'consumables'] }))
      .rejects.toThrow(/allowed_variable_cost_categories|check constraint/i)
    await expect(commitPolicy({ categories: ['Fixed Rent'] }))
      .rejects.toThrow(/allowed_variable_cost_categories|check constraint/i)
    await expect(one(`
      SELECT public.commit_economics_policy_version(
        $1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
        'USD','unknown_processor','merchant_1',30,'gross_margin_estimate',
        ARRAY['owner_actual_cost_export'],ARRAY['consumables'],
        '{"consumables":"owner_actual_cost_export"}'::jsonb,'excluded_from_contribution',
        $2,'owner_entry','owner sheet','2026-08-02T12:00:00Z','estimate-policy'
      )`, [ACCOUNT, HASH_A])).rejects.toThrow(/variable_cost_basis|check constraint/i)
  })

  it('rejects a policy for anything except the exact contribution objective and USD', async () => {
    await expect(one(`
      SELECT public.commit_economics_policy_version(
        $1,1,'maximize_platform_roas','USD','unknown_processor','merchant_1',30,
        'outcome_actual_entries',ARRAY['owner_actual_cost_export'],ARRAY['consumables'],
        '{"consumables":"owner_actual_cost_export"}'::jsonb,'excluded_from_contribution',
        $2,'owner_entry','owner sheet','2026-08-02T12:00:00Z','wrong-objective'
      )`, [ACCOUNT, HASH_A])).rejects.toThrow(/objective|check constraint/i)
    await expect(one(`
      SELECT public.commit_economics_policy_version(
        $1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
        'EUR','unknown_processor','merchant_1',30,'outcome_actual_entries',
        ARRAY['owner_actual_cost_export'],ARRAY['consumables'],
        '{"consumables":"owner_actual_cost_export"}'::jsonb,'excluded_from_contribution',
        $2,'owner_entry','owner sheet','2026-08-02T12:00:00Z','wrong-currency'
      )`, [ACCOUNT, HASH_A])).rejects.toThrow(/currency|check constraint/i)
  })

  it('requires the sole active account and honest provenance', async () => {
    await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [ACCOUNT])
    await expect(commitPolicy()).rejects.toThrow(/sole active ad account/i)
    await db.query(`UPDATE public.ad_accounts SET is_active=true WHERE id=$1`, [ACCOUNT])
    await expect(commitPolicy({ sourceRef: ' ' })).rejects.toThrow(/source ref|provenance/i)
    await expect(commitPolicy({ capturedAt: new Date(Date.now() + 86_400_000).toISOString() }))
      .rejects.toThrow(/future capture/i)
  })

  it('approves the exact latest policy with an effective time and future review deadline', async () => {
    const policy = await commitPolicy()
    const first = await approvePolicy(policy.id as string)
    const retry = await approvePolicy(policy.id as string)
    expect(retry).toMatchObject({ id: first.id, revision: 1, decision: 'approved' })
    await expect(approvePolicy(policy.id as string, null, {
      dedupe: 'expired-review', reviewDueAt: '2026-07-01T00:00:00Z',
    })).rejects.toThrow(/future review deadline/i)
    await expect(approvePolicy(policy.id as string, first.id as string, {
      dedupe: 'wrong-hash', hash: HASH_B,
    })).rejects.toThrow(/hash mismatch/i)
  })

  it('cannot approve an artifact whose declared capture time has not happened yet', async () => {
    const policy = await commitPolicy({
      capturedAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      dedupe: 'near-future-policy',
    })
    await expect(approvePolicy(policy.id as string, null, {
      dedupe: 'approve-near-future-policy',
    })).rejects.toThrow(/capture time.*not happened|future capture/i)
  })

  it('rejects stale approval heads and approval of an older superseded artifact', async () => {
    const firstPolicy = await commitPolicy()
    const firstApproval = await approvePolicy(firstPolicy.id as string)
    await expect(approvePolicy(firstPolicy.id as string, null, { dedupe: 'stale-head' }))
      .rejects.toThrow(/stale head/i)

    await commitPolicy({
      dedupe: 'economics-policy-v2', hash: HASH_B,
      categories: ['consumables', 'provider_commission', 'service_specific_fees'],
    })
    await expect(approvePolicy(firstPolicy.id as string, firstApproval.id as string, {
      dedupe: 'approve-old-policy',
    })).rejects.toThrow(/newer economics policy/i)
  })

  it('withdraws only the current approval and preserves the audit chain', async () => {
    const policy = await commitPolicy()
    const approval = await approvePolicy(policy.id as string)
    const withdrawn = await one<Record<string, unknown>>(`
      SELECT (public.withdraw_economics_policy_approval(
        $1,$2,'owner','Processor connection changed','withdraw-economics-v1'
      )).*`, [ACCOUNT, approval.id])
    expect(withdrawn).toMatchObject({ revision: 2, decision: 'withdrawn' })
    await expect(one(`
      SELECT public.withdraw_economics_policy_approval(
        $1,$2,'owner','retry under another key','withdraw-again'
      )`, [ACCOUNT, approval.id])).rejects.toThrow(/stale head|current approval/i)
  })

  it('keeps policy history immutable and denies application-role table writes and browser reads', async () => {
    const policy = await commitPolicy()
    await expect(db.query(`DELETE FROM public.economics_policy_versions WHERE id=$1`, [policy.id]))
      .rejects.toThrow(/immutable|append-only/i)
    await expect(db.query(`UPDATE public.economics_policy_versions SET processor='changed'`))
      .rejects.toThrow(/immutable|append-only/i)

    const grants = await one<{ dml: number; browser_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('economics_policy_versions'),('economics_policy_approvals')) t(table_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) AS dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('economics_policy_versions'),('economics_policy_approvals')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) AS browser_reads
    `)
    expect(grants).toEqual({ dml: 0, browser_reads: 0 })
  })
})
