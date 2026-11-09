import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import { hashCanonicalDocument, type BusinessContextDocumentV1,
  type LandingPageSnapshotDocumentV1 } from '@/lib/planning-context/contracts'
import { resolveGovernedPlanningContextForAccount } from '@/lib/planning-context/resolver'
import { executePlanningContextCommand } from '@/lib/planning-context/store'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (value: string) => { try { return new URL(value).hostname } catch { return '' } }

const ACCOUNT_A = '00000000-0000-4000-8000-000000000671'
const ACCOUNT_B = '00000000-0000-4000-8000-000000000672'
const ACCOUNT_C = '00000000-0000-4000-8000-000000000673'
const GOVERNED_TABLES = ['business_context_versions', 'business_context_approvals',
  'landing_page_snapshots', 'landing_page_approvals'] as const
const REVIEW_DUE = new Date(Date.now() + 90 * 86_400_000).toISOString()
const BUSINESS_CAPTURED_AT = '2026-07-30T10:00:00.000Z'

const BUSINESS_DOCUMENT: BusinessContextDocumentV1 = {
  schema_version: 1,
  business: {
    name: 'Context integration studio', market: 'Springfield, Massachusetts', timezone: 'America/New_York',
    currency: 'USD',
  },
  offers: [{
    id: 'studio-rental', name: 'Studio rental', description: 'Private hourly studio rental.',
    kind: 'studio_rental', status: 'active',
    meta_eligibility: 'allowed', booking_url: 'https://example.test/book/',
  }],
  audiences: [], approved_claims: [],
  economics: {
    target_cpa: null, max_cpa: null, contribution_margin_percent: null,
    monthly_meta_spend_ceiling: null, basis: null,
  },
  service_area: { status: 'unknown', markets: [], notes: null }, constraints: [],
  capacity: { status: 'unknown', weekly_booking_capacity: null, notes: null },
  seasonality: { status: 'unknown', periods: [], notes: null },
}

const PAGE_DOCUMENT: LandingPageSnapshotDocumentV1 = {
  schema_version: 1,
  requested_url: 'https://example.test/book/', final_url: 'https://example.test/book/',
  canonical_url: 'https://example.test/book/', purpose: 'booking',
  supported_funnel_stages: ['booking'], offer_ids: ['studio-rental'], claim_ids: [],
  ctas: [{ label: 'Book now', kind: 'scheduler', destination: 'https://example.test/book/' }],
  mobile: { status: 'pass', evidence: 'Integration fixture.' },
  runtime: { status: 'pass', http_status: 200, observed_at: new Date().toISOString() },
  tracking: { status: 'observed', inventory: ['GTM'] },
  content_summary: 'Integration booking page fixture.',
}

const BUSINESS_HASH = hashCanonicalDocument(BUSINESS_DOCUMENT)
const PAGE_HASH = hashCanonicalDocument(PAGE_DOCUMENT)

let db: pg.Client
let previouslyActiveAccountIds: string[] = []
const service = () => createClient(SB_URL, SERVICE, { auth: { persistSession: false } })

async function cleanup(): Promise<void> {
  await db.query(`DELETE FROM public.landing_page_approvals WHERE ad_account_id = ANY($1::uuid[])`, [[ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]])
  await db.query(`DELETE FROM public.landing_page_snapshots WHERE ad_account_id = ANY($1::uuid[])`, [[ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]])
  await db.query(`DELETE FROM public.business_context_approvals WHERE ad_account_id = ANY($1::uuid[])`, [[ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]])
  await db.query(`DELETE FROM public.business_context_versions WHERE ad_account_id = ANY($1::uuid[])`, [[ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]])
  await db.query(`DELETE FROM public.ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]])
}

async function activateOnly(accountId: string): Promise<void> {
  await db.query(`UPDATE public.ad_accounts SET is_active = (id = $1)`, [accountId])
}

beforeAll(async () => {
  for (const value of [SB_URL, DB]) {
    if (!LOOPBACK.has(hostOf(value))) throw new Error(`refusing non-loopback planning-context target: ${value}`)
  }
  if (!SERVICE) throw new Error('local service-role key is required')
  db = new pg.Client({ connectionString: DB })
  await db.connect()
  const activeAccounts = await db.query<{ id: string }>(
    `SELECT id FROM public.ad_accounts WHERE is_active IS TRUE`)
  previouslyActiveAccountIds = activeAccounts.rows.map(({ id }) => id)
  await cleanup()
  await db.query(
    `INSERT INTO public.ad_accounts(id,account_id,is_active) VALUES
      ($1,'act_context_671',false),($2,'act_context_672',false),($3,'act_context_673',false)`,
    [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C],
  )
  await activateOnly(ACCOUNT_A)
}, 60_000)

beforeEach(async () => { await activateOnly(ACCOUNT_A) })

afterAll(async () => {
  if (!db) return
  try {
    await cleanup()
  } finally {
    await db.query(`UPDATE public.ad_accounts SET is_active = (id = ANY($1::uuid[]))`,
      [previouslyActiveAccountIds]).finally(() => db.end())
  }
})

async function commitBusiness(
  accountId = ACCOUNT_A,
  dedupeKey = 'integration-business-v1',
  sourceRef = 'integration',
) {
  return service().rpc('commit_business_context_version', {
    p_ad_account_id: accountId,
    p_schema_version: 1,
    p_document: BUSINESS_DOCUMENT,
    p_content_hash: BUSINESS_HASH,
    p_source_kind: 'owner_entry',
    p_source_ref: sourceRef,
    p_captured_at: BUSINESS_CAPTURED_AT,
    p_dedupe_key: dedupeKey,
  })
}

async function ensureBusinessApproval(): Promise<{ artifactId: string; approvalId: string }> {
  const committed = await commitBusiness()
  expect(committed.error, committed.error?.message).toBeNull()
  const artifactId = (committed.data as { id: string }).id
  const current = await db.query(
    `SELECT id FROM public.business_context_approvals
      WHERE ad_account_id=$1 ORDER BY revision DESC LIMIT 1`,
    [ACCOUNT_A],
  )
  if (current.rows[0]?.id) return { artifactId, approvalId: String(current.rows[0].id) }

  const approved = await service().rpc('approve_business_context_version', {
    p_ad_account_id: ACCOUNT_A,
    p_artifact_id: artifactId,
    p_expected_hash: BUSINESS_HASH,
    p_expected_previous_approval_id: null,
    p_reviewed_by: 'owner',
    p_reason: 'Independent integration fixture',
    p_review_due_at: REVIEW_DUE,
    p_dedupe_key: 'integration-independent-business-approval',
  })
  expect(approved.error, approved.error?.message).toBeNull()
  return { artifactId, approvalId: (approved.data as { id: string }).id }
}

describe('governed context through real PostgREST', () => {
  it('allows service-role RPC commits but denies every direct application-role write', async () => {
    const committed = await commitBusiness()
    expect(committed.error, committed.error?.message).toBeNull()
    expect((committed.data as { content_hash: string }).content_hash).toBe(BUSINESS_HASH)

    const direct = await service().from('business_context_versions').insert({
      ad_account_id: ACCOUNT_A,
      schema_version: 1,
      document: BUSINESS_DOCUMENT,
      content_hash: BUSINESS_HASH,
      source_kind: 'owner_entry',
      captured_at: new Date().toISOString(),
      dedupe_key: 'forbidden-direct-write',
    })
    expect(direct.error, 'service_role direct insert must be denied').not.toBeNull()

    const { rows } = await db.query(`
      SELECT
        has_table_privilege('authenticated','public.business_context_versions','SELECT') auth_read,
        has_table_privilege('anon','public.landing_page_snapshots','SELECT') anon_read,
        has_function_privilege('authenticated',
          'public.commit_business_context_version(uuid,integer,jsonb,text,text,text,timestamptz,text)',
          'EXECUTE') auth_commit,
        has_function_privilege('authenticated',
          'public.read_governed_planning_context(uuid,text)','EXECUTE') auth_context_read`)
    expect(rows[0]).toEqual({
      auth_read: false,
      anon_read: false,
      auth_commit: false,
      auth_context_read: false,
    })
  })

  it('enforces the complete governed-table read and RLS permission matrix', async () => {
    const { rows } = await db.query<{
      anon_select_count: number; authenticated_select_count: number
      service_select_count: number; rls_count: number
    }>(`
      WITH governed(table_name) AS (VALUES ('business_context_versions'),
        ('business_context_approvals'),('landing_page_snapshots'),('landing_page_approvals'))
      SELECT
        (SELECT count(*)::int FROM governed WHERE
          has_table_privilege('anon','public.' || table_name,'SELECT')) anon_select_count,
        (SELECT count(*)::int FROM governed WHERE
          has_table_privilege('authenticated','public.' || table_name,'SELECT')) authenticated_select_count,
        (SELECT count(*)::int FROM governed WHERE
          has_table_privilege('service_role','public.' || table_name,'SELECT')) service_select_count,
        (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN governed g ON g.table_name=c.relname
          WHERE c.relnamespace='public'::regnamespace AND c.relrowsecurity IS TRUE) rls_count
    `)
    expect(rows[0]).toEqual({ anon_select_count: 0, authenticated_select_count: 0,
      service_select_count: 4, rls_count: 4 })
  })

  it('runs this local PostgreSQL harness connection at READ COMMITTED isolation', async () => {
    const { rows } = await db.query<{
      transaction_isolation: string; default_transaction_isolation: string
    }>(`
      SELECT
        current_setting('transaction_isolation') transaction_isolation,
        current_setting('default_transaction_isolation') default_transaction_isolation
    `)
    expect(rows[0]).toEqual({ transaction_isolation: 'read committed',
      default_transaction_isolation: 'read committed' })
  })

  it('keeps the trigger boundary intact if a future blanket DML grant returns', async () => {
    await db.query(`GRANT INSERT,UPDATE,DELETE ON public.business_context_versions TO service_role`)
    try {
      const direct = await service().from('business_context_versions').insert({
        ad_account_id: ACCOUNT_A,
        schema_version: 1,
        document: BUSINESS_DOCUMENT,
        content_hash: BUSINESS_HASH,
        source_kind: 'owner_entry',
        captured_at: new Date().toISOString(),
        dedupe_key: 'forbidden-even-with-grant',
      })
      expect(direct.error?.message).toMatch(/must use the governed RPCs/i)
    } finally {
      await db.query(`REVOKE INSERT,UPDATE,DELETE ON public.business_context_versions FROM service_role`)
    }
  })

  it('blocks a PostgREST writer on the account advisory lock until the holder commits', async () => {
    await activateOnly(ACCOUNT_B)
    const locker = new pg.Client({ connectionString: DB })
    await locker.connect()
    let settled = false
    let pending: Promise<{ data: unknown; error: { message: string } | null }> | null = null
    try {
      const holder = await locker.query<{ pid: number }>(`SELECT pg_backend_pid()::int pid`)
      const holderPid = holder.rows[0].pid
      await locker.query('BEGIN')
      await locker.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::uuid::text || ':governed-planning-context',0))`,
        [ACCOUNT_B],
      )
      pending = Promise.resolve(commitBusiness(
        ACCOUNT_B, 'lock-wait-business-v1', 'advisory lock integration',
      )).then((result) => {
        settled = true
        return result
      })

      let exactWaiters = 0
      for (let attempt = 0; attempt < 200 && exactWaiters === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const waiting = await db.query<{ n: number }>(
          `WITH expected AS (
             SELECT pg_catalog.hashtextextended($1::uuid::text || ':governed-planning-context',0) lock_key
           )
           SELECT count(*)::int n FROM pg_catalog.pg_locks l CROSS JOIN expected e
            WHERE l.locktype='advisory' AND l.objsubid=1 AND l.mode='ExclusiveLock'
              AND l.database=(SELECT oid FROM pg_catalog.pg_database
                WHERE datname=current_database()) AND l.granted IS FALSE
              AND ((l.classid::bigint << 32) | l.objid::bigint) = e.lock_key
              AND $2::int = ANY(pg_catalog.pg_blocking_pids(l.pid))`,
          [ACCOUNT_B, holderPid],
        )
        exactWaiters = waiting.rows[0]?.n ?? 0
      }
      expect(exactWaiters).toBe(1)
      expect(settled).toBe(false)

      await locker.query('COMMIT')
      if (!pending) throw new Error('PostgREST lock contender was not started')
      const committed = await pending
      expect(committed.error, committed.error?.message).toBeNull()
      expect(settled).toBe(true)
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined)
      await locker.end()
      await pending?.catch(() => undefined)
    }
  })

  it('rechecks the sole active account after a concurrent account flip commits', async () => {
    const flipper = new pg.Client({ connectionString: DB })
    const dedupeKey = 'account-flip-toctou-business-v1'
    await flipper.connect()
    let settled = false
    let pending: ReturnType<typeof commitBusiness> | null = null
    try {
      const holder = await flipper.query<{ pid: number }>(`SELECT pg_backend_pid()::int pid`)
      await flipper.query('BEGIN')
      await flipper.query(`UPDATE public.ad_accounts SET is_active = (id = $1)`, [ACCOUNT_B])
      pending = commitBusiness(ACCOUNT_A, dedupeKey, 'account flip TOCTOU').then((result) => {
        settled = true
        return result
      })

      let exactWaiters = 0
      for (let attempt = 0; attempt < 200 && exactWaiters === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const waiting = await db.query<{ n: number }>(`
          SELECT count(*)::int n FROM pg_catalog.pg_locks l WHERE l.locktype='relation'
            AND l.relation='public.ad_accounts'::regclass AND l.mode='ShareLock'
            AND l.granted IS FALSE AND $1::int=ANY(pg_catalog.pg_blocking_pids(l.pid))
        `, [holder.rows[0].pid])
        exactWaiters = waiting.rows[0]?.n ?? 0
      }
      expect(exactWaiters).toBe(1)
      expect(settled).toBe(false)

      await flipper.query('COMMIT')
      const rejected = await pending
      expect(rejected.error?.message).toMatch(/sole active ad account/i)
      const writes = await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM public.business_context_versions
          WHERE ad_account_id=$1 AND dedupe_key=$2`,
        [ACCOUNT_A, dedupeKey],
      )
      expect(writes.rows[0].n).toBe(0)
    } finally {
      await flipper.query('COMMIT').catch(() => undefined)
      await flipper.end()
      await pending?.catch(() => undefined)
    }
  })

  it('serializes concurrent reviews so exactly one claimant advances the approval head', async () => {
    const committed = await commitBusiness()
    expect(committed.error, committed.error?.message).toBeNull()
    const artifactId = (committed.data as { id: string }).id
    const base = {
      p_ad_account_id: ACCOUNT_A,
      p_artifact_id: artifactId,
      p_expected_hash: BUSINESS_HASH,
      p_expected_previous_approval_id: null,
      p_reviewed_by: 'owner',
      p_reason: 'Concurrent integration review',
      p_review_due_at: REVIEW_DUE,
    }
    const [a, b] = await Promise.all([
      service().rpc('approve_business_context_version', { ...base, p_dedupe_key: 'concurrent-review-a' }),
      service().rpc('approve_business_context_version', { ...base, p_dedupe_key: 'concurrent-review-b' }),
    ])
    const results = [a, b]
    expect(results.filter((result) => result.error == null)).toHaveLength(1)
    expect(results.filter((result) => result.error?.message.match(/stale head/i))).toHaveLength(1)
    const { rows } = await db.query(
      `SELECT count(*)::int n FROM public.business_context_approvals WHERE ad_account_id=$1`, [ACCOUNT_A])
    expect(rows[0].n).toBe(1)
  })

  it('rejects cross-account lineage and resolves an exact approved page end to end', async () => {
    const business = await ensureBusinessApproval()
    const page = await service().rpc('commit_landing_page_snapshot', {
      p_ad_account_id: ACCOUNT_A,
      p_schema_version: 1,
      p_requested_url: PAGE_DOCUMENT.requested_url,
      p_final_url: PAGE_DOCUMENT.final_url,
      p_canonical_url: PAGE_DOCUMENT.canonical_url,
      p_document: PAGE_DOCUMENT,
      p_content_hash: PAGE_HASH,
      p_source_kind: 'browser_probe',
      p_source_ref: 'integration',
      p_captured_at: new Date().toISOString(),
      p_dedupe_key: 'integration-page-v1',
    })
    expect(page.error, page.error?.message).toBeNull()

    await activateOnly(ACCOUNT_B)
    const crossAccount = await service().rpc('approve_business_context_version', {
      p_ad_account_id: ACCOUNT_B,
      p_artifact_id: business.artifactId,
      p_expected_hash: BUSINESS_HASH,
      p_expected_previous_approval_id: null,
      p_reviewed_by: 'owner',
      p_reason: 'Must fail',
      p_review_due_at: REVIEW_DUE,
      p_dedupe_key: 'cross-account-must-fail',
    })
    expect(crossAccount.error?.message).toMatch(/account mismatch|not found/i)
    await activateOnly(ACCOUNT_A)

    const approvedPage = await service().rpc('approve_landing_page_snapshot', {
      p_ad_account_id: ACCOUNT_A,
      p_artifact_id: (page.data as { id: string }).id,
      p_expected_hash: PAGE_HASH,
      p_business_context_approval_id: business.approvalId,
      p_expected_previous_approval_id: null,
      p_reviewed_by: 'owner',
      p_reason: 'Exact page reviewed',
      p_review_due_at: REVIEW_DUE,
      p_dedupe_key: 'integration-approve-page-v1',
    })
    expect(approvedPage.error, approvedPage.error?.message).toBeNull()

    const resolved = await resolveGovernedPlanningContextForAccount(
      service() as never,
      ACCOUNT_A,
      'https://example.test/book/',
    )
    expect(resolved).toMatchObject({
      status: 'approved_current',
      context_available_for_campaign_plan: true,
      blocker_codes: [],
      business_context: { status: 'approved_current' },
      landing_page: { status: 'approved_current' },
    })

    const otherPage = await resolveGovernedPlanningContextForAccount(
      service() as never,
      ACCOUNT_A,
      'https://example.test/',
    )
    expect(otherPage.landing_page.status).toBe('missing')
    expect(otherPage.context_available_for_campaign_plan).toBe(false)
  })

  it('runs the production store adapter through PostgREST and resolves its approved result', async () => {
    await activateOnly(ACCOUNT_C)
    const client = service()
    const business = await executePlanningContextCommand(client as never, ACCOUNT_C, 'owner@example.com', {
      action: 'commit_business',
      document: BUSINESS_DOCUMENT,
      source_kind: 'owner_entry',
      source_ref: 'real store adapter integration',
      captured_at: new Date().toISOString(),
      dedupe_key: 'store-adapter-business-v1',
    }) as { id: string }
    const businessApproval = await executePlanningContextCommand(
      client as never,
      ACCOUNT_C,
      'owner@example.com',
      {
        action: 'approve_business',
        artifact_id: business.id,
        expected_previous_approval_id: null,
        reason: 'Store adapter business approval',
        review_due_at: REVIEW_DUE,
        dedupe_key: 'store-adapter-business-approval-v1',
      },
    ) as { id: string }
    const page = await executePlanningContextCommand(client as never, ACCOUNT_C, 'owner@example.com', {
      action: 'commit_page',
      document: PAGE_DOCUMENT,
      source_kind: 'browser_probe',
      source_ref: 'real store adapter integration',
      captured_at: new Date().toISOString(),
      dedupe_key: 'store-adapter-page-v1',
    }) as { id: string }
    await executePlanningContextCommand(client as never, ACCOUNT_C, 'owner@example.com', {
      action: 'approve_page',
      artifact_id: page.id,
      business_context_approval_id: businessApproval.id,
      expected_previous_approval_id: null,
      reason: 'Store adapter page approval',
      review_due_at: REVIEW_DUE,
      dedupe_key: 'store-adapter-page-approval-v1',
    })

    const resolved = await resolveGovernedPlanningContextForAccount(
      client as never,
      ACCOUNT_C,
      PAGE_DOCUMENT.canonical_url,
    )
    expect(resolved).toMatchObject({
      status: 'approved_current',
      context_available_for_campaign_plan: true,
      blocker_codes: [],
      business_context: { version_id: business.id, approval_id: businessApproval.id },
      landing_page: { snapshot_id: page.id, status: 'approved_current' },
    })
  })

  it.each(GOVERNED_TABLES)(
    'blocks TRUNCATE on public.%s under the service role if its grant drifts back in',
    async (table) => {
      const guard = new pg.Client({ connectionString: DB })
      await guard.connect()
      try {
        await guard.query('BEGIN')
        const qualifiedTables = GOVERNED_TABLES.map((name) => `public.${name}`).join(',')
        await guard.query(`GRANT TRUNCATE ON ${qualifiedTables} TO service_role`)
        // CASCADE clears FK blockers; disabling only the other guards isolates the named table's trigger.
        for (const other of GOVERNED_TABLES.filter((name) => name !== table)) {
          await guard.query(`ALTER TABLE public.${other} DISABLE TRIGGER ${other}_no_truncate`)
        }
        await guard.query('SET ROLE service_role')
        await expect(guard.query(`TRUNCATE TABLE public.${table} CASCADE`))
          .rejects.toThrow(/governed context writes must use the governed RPCs/i)
      } finally {
        await guard.query('ROLLBACK').catch(() => undefined)
        await guard.end()
      }
    },
  )
})
