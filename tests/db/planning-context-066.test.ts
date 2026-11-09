import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT_A = '00000000-0000-4000-8000-000000000661'
const ACCOUNT_B = '00000000-0000-4000-8000-000000000662'
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const HASH_C = `sha256:${'c'.repeat(64)}`
const FUTURE_REVIEW = new Date(Date.now() + 365 * 86_400_000).toISOString()

let db: PGlite

async function callOne<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT_A, 'act_context_a')
  await insertAdAccount(db, ACCOUNT_B, 'act_context_b')
  await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [ACCOUNT_B])
})

async function commitBusiness(
  account = ACCOUNT_A,
  dedupe = 'business-a-v1',
  hash = HASH_A,
  document = JSON.stringify({ schema_version: 1, business: { name: 'Studio A' } }),
  capturedAt = '2026-07-30T10:00:00Z',
  sourceRef: string | null = 'owner-review',
): Promise<{ id: string; content_hash: string }> {
  return callOne(`
    SELECT (public.commit_business_context_version(
      $1, 1, $2::jsonb, $3, 'owner_entry', $4,
      $5, $6
    )).*`, [account, document, hash, sourceRef, capturedAt, dedupe])
}

async function approveBusiness(
  artifactId: string,
  expectedPrevious: string | null = null,
  account = ACCOUNT_A,
  dedupe = 'approve-business-a-v1',
  hash = HASH_A,
): Promise<{ id: string; revision: number; decision: string }> {
  return callOne(`
    SELECT (public.approve_business_context_version(
      $1,$2,$3,$4,'owner','Initial owner review',$5,$6
    )).*`, [account, artifactId, hash, expectedPrevious, FUTURE_REVIEW, dedupe])
}

async function commitPage(
  account = ACCOUNT_A,
  canonicalUrl = 'https://example.test/book/',
  dedupe = 'page-a-book-v1',
  hash = HASH_B,
  document = JSON.stringify({ schema_version: 1, canonical_url: canonicalUrl, purpose: 'booking' }),
  capturedAt = '2026-07-30T10:30:00Z',
): Promise<{ id: string; canonical_url: string; content_hash: string }> {
  return callOne(`
    SELECT (public.commit_landing_page_snapshot(
      $1,1,'https://example.test/book/','https://example.test/book/',$2,
      $3::jsonb,$4,'marketing_team_export','book-page-export',
      $5,$6
    )).*`, [
    account,
    canonicalUrl,
    document,
    hash,
    capturedAt,
    dedupe,
  ])
}

async function approvePage(
  artifactId: string,
  businessApprovalId: string,
  expectedPrevious: string | null = null,
  account = ACCOUNT_A,
  dedupe = 'approve-page-a-book-v1',
): Promise<{ id: string; revision: number; decision: string }> {
  return callOne(`
    SELECT (public.approve_landing_page_snapshot(
      $1,$2,$3,$4,$5,'owner','Page facts reviewed',$6,$7
    )).*`, [account, artifactId, HASH_B, businessApprovalId, expectedPrevious, FUTURE_REVIEW, dedupe])
}

describe('governed business/page context substrate', () => {
  it('commits an identical business observation idempotently and rejects a payload collision', async () => {
    const first = await commitBusiness()
    const retry = await commitBusiness()
    expect(retry.id).toBe(first.id)
    await expect(commitBusiness(ACCOUNT_A, 'business-a-v1', HASH_C))
      .rejects.toThrow(/dedupe collision/i)
    const count = await callOne<{ n: number }>(
      `SELECT count(*)::int n FROM public.business_context_versions WHERE ad_account_id=$1`,
      [ACCOUNT_A],
    )
    expect(count.n).toBe(1)
  })

  it('requires provenance and rejects a manufactured future capture time', async () => {
    await expect(commitBusiness(
      ACCOUNT_A,
      'missing-source-ref',
      HASH_A,
      JSON.stringify({ schema_version: 1, business: { name: 'Studio A' } }),
      '2026-07-30T10:00:00Z',
      null,
    )).rejects.toThrow(/source ref|provenance/i)
    await expect(commitBusiness(
      ACCOUNT_A,
      'future-capture',
      HASH_A,
      JSON.stringify({ schema_version: 1, business: { name: 'Studio A' } }),
      new Date(Date.now() + 2 * 86_400_000).toISOString(),
    )).rejects.toThrow(/future capture/i)
  })

  it('rejects a governed write unless the target is still the sole active account', async () => {
    await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [ACCOUNT_A])
    await expect(commitBusiness()).rejects.toThrow(/sole active ad account/i)

    await db.query(`UPDATE public.ad_accounts SET is_active=true`)
    await expect(commitBusiness()).rejects.toThrow(/sole active ad account/i)

    const guarded = await callOne<{ n: number }>(`
      SELECT count(*)::int n
        FROM pg_catalog.pg_proc p
       WHERE p.proname = ANY($1::text[])
         AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%LOCK TABLE public.ad_accounts IN SHARE MODE%'
         AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%count(*) = 1%'
    `, [[
      'commit_business_context_version',
      'commit_landing_page_snapshot',
      'approve_business_context_version',
      'withdraw_business_context_approval',
      'approve_landing_page_snapshot',
      'withdraw_landing_page_approval',
    ]])
    expect(guarded.n).toBe(6)
  })

  it('commits an identical page observation idempotently and preserves exact URL identity', async () => {
    const first = await commitPage()
    const retry = await commitPage()
    expect(retry.id).toBe(first.id)
    expect(first.canonical_url).toBe('https://example.test/book/')
    await expect(commitPage(ACCOUNT_A, 'https://example.test/', 'page-a-book-v1'))
      .rejects.toThrow(/dedupe collision/i)
  })

  it('makes approved facts immutable while permitting table-owner fixture cleanup', async () => {
    const business = await commitBusiness()
    await expect(db.query(
      `UPDATE public.business_context_versions SET content_hash=$1 WHERE id=$2`,
      [HASH_C, business.id],
    )).rejects.toThrow(/immutable/i)
    await expect(db.query(
      `DELETE FROM public.business_context_versions WHERE id=$1`, [business.id],
    )).resolves.toBeTruthy()
  })

  it('blocks TRUNCATE independently on every governed table if a future grant drifts in', async () => {
    for (const table of [
      'landing_page_approvals',
      'landing_page_snapshots',
      'business_context_approvals',
      'business_context_versions',
    ]) {
      await db.exec(`GRANT TRUNCATE ON public.${table} TO service_role`)
      await db.exec(`SET ROLE service_role`)
      try {
        // PostgreSQL may reject a referenced parent before firing its table trigger. The exact
        // trigger-to-table/event/function map is asserted by both replay scripts; this behavioral
        // proof independently requires every individual target to remain non-truncatable.
        await expect(db.exec(`TRUNCATE public.${table}`)).rejects.toBeDefined()
      } finally {
        await db.exec(`RESET ROLE`)
        await db.exec(`REVOKE TRUNCATE ON public.${table} FROM service_role`)
      }
    }
  })

  it('rejects a canonical URL whose UTF-8 size exceeds the indexed identity limit', async () => {
    const oversized = `https://example.test/book/?q=${'x'.repeat(2050)}`
    await expect(commitPage(
      ACCOUNT_A,
      oversized,
      'oversized-page-url',
      HASH_B,
      JSON.stringify({ schema_version: 1, canonical_url: oversized }),
    )).rejects.toThrow(/landing_page_canonical_http|check constraint/i)
  })

  it('enforces document-size and observation chronology limits at the RPC boundary', async () => {
    await expect(commitBusiness(
      ACCOUNT_A,
      'oversized-business-document',
      HASH_A,
      JSON.stringify({ schema_version: 1, padding: 'x'.repeat(25 * 1024) }),
    )).rejects.toThrow(/business_context_document_size|check constraint/i)

    await expect(commitPage(
      ACCOUNT_A,
      'https://example.test/book/',
      'oversized-page-document',
      HASH_B,
      JSON.stringify({ schema_version: 1, padding: 'x'.repeat(17 * 1024) }),
    )).rejects.toThrow(/landing_page_document_size|check constraint/i)

    await expect(commitPage(
      ACCOUNT_A,
      'https://example.test/book/',
      'postdated-runtime-observation',
      HASH_B,
      JSON.stringify({
        schema_version: 1,
        runtime: { observed_at: '2026-07-30T10:31:00Z' },
      }),
      '2026-07-30T10:30:00Z',
    )).rejects.toThrow(/runtime observation.*capture time/i)
  })

  it('approves an exact business hash with a future owner deadline and idempotent retry', async () => {
    const business = await commitBusiness()
    const first = await approveBusiness(business.id)
    const retry = await approveBusiness(business.id)
    expect(retry).toMatchObject({ id: first.id, revision: 1, decision: 'approved' })

    await expect(callOne(`
      SELECT public.approve_business_context_version(
        $1,$2,$3,NULL,'different-owner','Changed retry',$4,'approve-business-a-v1'
      )`, [ACCOUNT_A, business.id, HASH_A, FUTURE_REVIEW]))
      .rejects.toThrow(/dedupe collision/i)

    await expect(callOne(`
      SELECT public.approve_business_context_version(
        $1,$2,$3,$4,'owner','Expired review','2026-07-01T00:00:00Z','expired-decision'
      )`, [ACCOUNT_A, business.id, HASH_A, first.id])).rejects.toThrow(/future review deadline/i)
    await expect(approveBusiness(business.id, first.id, ACCOUNT_A, 'wrong-hash', HASH_C))
      .rejects.toThrow(/hash mismatch/i)
  })

  it('rejects a stale approval head instead of silently overwriting a concurrent review', async () => {
    const business = await commitBusiness()
    const first = await approveBusiness(business.id)
    await expect(approveBusiness(business.id, null, ACCOUNT_A, 'stale-review'))
      .rejects.toThrow(/stale head/i)

    const second = await approveBusiness(business.id, first.id, ACCOUNT_A, 'renew-review')
    expect(second.revision).toBe(2)
  })

  it('cannot approve an older artifact after a newer different observation is committed', async () => {
    const first = await commitBusiness()
    const firstApproval = await approveBusiness(first.id)
    await commitBusiness(
      ACCOUNT_A,
      'business-a-v2',
      HASH_C,
      JSON.stringify({ schema_version: 1, business: { name: 'Studio A changed' } }),
    )
    await expect(approveBusiness(
      first.id,
      firstApproval.id,
      ACCOUNT_A,
      'approve-stale-observation',
      HASH_A,
    )).rejects.toThrow(/newer business observation/i)
  })

  it('allows a same-content recapture without invalidating the reviewed content', async () => {
    const first = await commitBusiness()
    const firstApproval = await approveBusiness(first.id)
    await commitBusiness(ACCOUNT_A, 'business-a-recapture', HASH_A)
    const renewed = await approveBusiness(
      first.id,
      firstApproval.id,
      ACCOUNT_A,
      'approve-after-same-content-recapture',
      HASH_A,
    )
    expect(renewed.revision).toBe(2)
  })

  it('binds page approval to the exact current business approval', async () => {
    const business = await commitBusiness()
    const businessApproval = await approveBusiness(business.id)
    const page = await commitPage()
    const first = await approvePage(page.id, businessApproval.id)
    expect(first).toMatchObject({ revision: 1, decision: 'approved' })
    const retry = await approvePage(page.id, businessApproval.id)
    expect(retry.id).toBe(first.id)
    await expect(callOne(`
      SELECT public.approve_landing_page_snapshot(
        $1,$2,$3,$4,NULL,'different-owner','Changed retry',$5,'approve-page-a-book-v1'
      )`, [ACCOUNT_A, page.id, HASH_B, businessApproval.id, FUTURE_REVIEW]))
      .rejects.toThrow(/dedupe collision/i)

    const renewedBusiness = await approveBusiness(
      business.id,
      businessApproval.id,
      ACCOUNT_A,
      'renew-business-for-page-conflict',
    )
    await expect(approvePage(page.id, businessApproval.id, first.id, ACCOUNT_A, 'stale-business-link'))
      .rejects.toThrow(/business context.*not current/i)
    await expect(approvePage(page.id, renewedBusiness.id, null, ACCOUNT_A, 'stale-page-head'))
      .rejects.toThrow(/stale head/i)
  })

  it('blocks page approval when newer business or page facts await review', async () => {
    const business = await commitBusiness()
    const businessApproval = await approveBusiness(business.id)
    const page = await commitPage()

    await commitBusiness(
      ACCOUNT_A,
      'business-newer-before-page-review',
      HASH_C,
      JSON.stringify({ schema_version: 1, business: { name: 'Changed' } }),
    )
    await expect(approvePage(page.id, businessApproval.id, null, ACCOUNT_A, 'page-stale-business'))
      .rejects.toThrow(/newer business observation|business context.*not current/i)

    const newBusinessApproval = await approveBusiness(
      (await callOne<{ id: string }>(
        `SELECT id FROM public.business_context_versions WHERE ad_account_id=$1 AND content_hash=$2`,
        [ACCOUNT_A, HASH_C],
      )).id,
      businessApproval.id,
      ACCOUNT_A,
      'approve-new-business',
      HASH_C,
    )
    await commitPage(
      ACCOUNT_A,
      'https://example.test/book/',
      'page-a-book-v2',
      HASH_C,
      JSON.stringify({ schema_version: 1, canonical_url: 'https://example.test/book/', purpose: 'lead_capture' }),
    )
    await expect(approvePage(page.id, newBusinessApproval.id, null, ACCOUNT_A, 'approve-stale-page'))
      .rejects.toThrow(/newer landing page observation/i)
  })

  it('rejects cross-account artifacts and approval lineage', async () => {
    const businessA = await commitBusiness()
    const approvalA = await approveBusiness(businessA.id)

    await db.query(`UPDATE public.ad_accounts SET is_active=(id=$1)`, [ACCOUNT_B])
    await expect(approveBusiness(businessA.id, null, ACCOUNT_B, 'cross-account-business'))
      .rejects.toThrow(/account mismatch|not found/i)

    const pageB = await commitPage(ACCOUNT_B, 'https://example.test/book/', 'page-b-book-v1')
    await expect(approvePage(pageB.id, approvalA.id, null, ACCOUNT_B, 'cross-account-lineage'))
      .rejects.toThrow(/account mismatch|not current/i)
  })

  it('reads one exact-account, exact-URL authority snapshot in a single RPC', async () => {
    const business = await commitBusiness()
    const businessApproval = await approveBusiness(business.id)
    const page = await commitPage()
    await approvePage(page.id, businessApproval.id)

    const snapshot = await callOne<{
      snapshot: Record<string, Record<string, unknown> | null>
    }>(
      `SELECT public.read_governed_planning_context($1,$2) AS snapshot`,
      [ACCOUNT_A, 'https://example.test/book/'],
    )
    const data = snapshot.snapshot
    expect(data.latest_business_observation?.ad_account_id).toBe(ACCOUNT_A)
    expect(data.latest_page_observation?.canonical_url).toBe('https://example.test/book/')
    expect(data.latest_page_decision?.canonical_url).toBe('https://example.test/book/')

    const other = await callOne<{ snapshot: Record<string, unknown> }>(
      `SELECT public.read_governed_planning_context($1,$2) AS snapshot`,
      [ACCOUNT_A, 'https://example.test/'],
    )
    expect(other.snapshot.latest_page_observation).toBeNull()
    expect(other.snapshot.latest_page_decision).toBeNull()
  })

  it('supports explicit append-only withdrawal without rewriting the approved event', async () => {
    const business = await commitBusiness()
    const approval = await approveBusiness(business.id)
    const withdrawn = await callOne<{ id: string; decision: string; revision: number }>(`
      SELECT (public.withdraw_business_context_approval(
        $1,$2,'owner','Offer no longer approved','withdraw-business-a-v1'
      )).*`, [ACCOUNT_A, approval.id])
    expect(withdrawn).toMatchObject({ decision: 'withdrawn', revision: 2 })
    const original = await callOne<{ decision: string }>(
      `SELECT decision FROM public.business_context_approvals WHERE id=$1`, [approval.id])
    expect(original.decision).toBe('approved')

    await expect(callOne(`
      SELECT public.withdraw_business_context_approval(
        $1,$2,'different-actor','changed retry payload','withdraw-business-a-v1'
      )`, [ACCOUNT_A, approval.id])).rejects.toThrow(/dedupe collision/i)
  })

  it('withdraws a page append-only and rejects a changed retry payload', async () => {
    const business = await commitBusiness()
    const businessApproval = await approveBusiness(business.id)
    const page = await commitPage()
    const approval = await approvePage(page.id, businessApproval.id)
    const withdrawn = await callOne<{ id: string; decision: string; revision: number }>(`
      SELECT (public.withdraw_landing_page_approval(
        $1,'https://example.test/book/',$2,'owner','Page retired','withdraw-page-a-v1'
      )).*`, [ACCOUNT_A, approval.id])
    expect(withdrawn).toMatchObject({ decision: 'withdrawn', revision: 2 })

    await expect(callOne(`
      SELECT public.withdraw_landing_page_approval(
        $1,'https://example.test/book/',$2,'different-actor','changed retry','withdraw-page-a-v1'
      )`, [ACCOUNT_A, approval.id])).rejects.toThrow(/dedupe collision/i)
  })

  it('rejects changed withdrawal payloads that reuse an idempotency key', async () => {
    const business = await commitBusiness()
    const approval = await approveBusiness(business.id)
    await callOne(`
      SELECT (public.withdraw_business_context_approval(
        $1,$2,'owner','First reason','withdraw-collision'
      )).*`, [ACCOUNT_A, approval.id])
    await expect(callOne(`
      SELECT (public.withdraw_business_context_approval(
        $1,$2,'different-owner','Changed reason','withdraw-collision'
    )).*`, [ACCOUNT_A, approval.id])).rejects.toThrow(/dedupe collision/i)
  })

  it('applies the same idempotency collision rule to page withdrawals', async () => {
    const business = await commitBusiness()
    const businessApproval = await approveBusiness(business.id)
    const page = await commitPage()
    const pageApproval = await approvePage(page.id, businessApproval.id)
    await callOne(`
      SELECT (public.withdraw_landing_page_approval(
        $1,$2,$3,'owner','First reason','withdraw-page-collision'
      )).*`, [ACCOUNT_A, page.canonical_url, pageApproval.id])
    await expect(callOne(`
      SELECT (public.withdraw_landing_page_approval(
        $1,$2,$3,'different-owner','Changed reason','withdraw-page-collision'
      )).*`, [ACCOUNT_A, page.canonical_url, pageApproval.id]))
      .rejects.toThrow(/dedupe collision/i)
  })

  it('enforces account ownership in foreign keys, not only inside RPC code', async () => {
    const business = await commitBusiness()
    await expect(db.query(`
      INSERT INTO public.business_context_approvals(
        ad_account_id,artifact_id,artifact_hash,decision,revision,reviewed_by,reason,
        review_due_at,dedupe_key
      ) VALUES ($1,$2,$3,'approved',1,'owner','cross account',$4,'cross-account-direct')
    `, [ACCOUNT_B, business.id, HASH_A, FUTURE_REVIEW])).rejects.toThrow(/foreign key|account/i)
  })

  it('prevents a page approval chain from pointing at another URL in the same account', async () => {
    const business = await commitBusiness()
    const businessApproval = await approveBusiness(business.id)
    const pageA = await commitPage()
    const approvalA = await approvePage(pageA.id, businessApproval.id)
    const pageB = await commitPage(
      ACCOUNT_A,
      'https://example.test/other/',
      'page-a-other-v1',
      HASH_C,
      JSON.stringify({ schema_version: 1, canonical_url: 'https://example.test/other/' }),
    )

    await expect(db.query(`
      INSERT INTO public.landing_page_approvals(
        ad_account_id,canonical_url,artifact_id,artifact_hash,business_context_approval_id,
        decision,revision,previous_approval_id,reviewed_by,reason,review_due_at,dedupe_key
      ) VALUES ($1,$2,$3,$4,$5,'approved',1,$6,'owner','cross-url predecessor',$7,'cross-url-direct')
    `, [
      ACCOUNT_A, pageB.canonical_url, pageB.id, HASH_C, businessApproval.id, approvalA.id, FUTURE_REVIEW,
    ])).rejects.toThrow(/foreign key/i)
  })

  it('grants service_role read-only tables and governed RPC execution only', async () => {
    const privileges = await callOne<{
      service_select: boolean
      service_insert: boolean
      auth_select: boolean
      anon_select: boolean
      commit_execute: boolean
      auth_execute: boolean
      read_execute: boolean
      auth_read_execute: boolean
    }>(`
      SELECT
        has_table_privilege('service_role','public.business_context_versions','SELECT') service_select,
        has_table_privilege('service_role','public.business_context_versions','INSERT') service_insert,
        has_table_privilege('authenticated','public.business_context_versions','SELECT') auth_select,
        has_table_privilege('anon','public.landing_page_snapshots','SELECT') anon_select,
        has_function_privilege('service_role',
          'public.commit_business_context_version(uuid,integer,jsonb,text,text,text,timestamptz,text)',
          'EXECUTE') commit_execute,
        has_function_privilege('authenticated',
          'public.commit_business_context_version(uuid,integer,jsonb,text,text,text,timestamptz,text)',
          'EXECUTE') auth_execute,
        has_function_privilege('service_role',
          'public.read_governed_planning_context(uuid,text)', 'EXECUTE') read_execute,
        has_function_privilege('authenticated',
          'public.read_governed_planning_context(uuid,text)', 'EXECUTE') auth_read_execute
    `)
    expect(privileges).toEqual({
      service_select: true,
      service_insert: false,
      auth_select: false,
      anon_select: false,
      commit_execute: true,
      auth_execute: false,
      read_execute: true,
      auth_read_execute: false,
    })

    const matrix = await callOne<{
      service_select_count: number
      browser_select_count: number
      rls_count: number
    }>(`
      WITH governed(table_name) AS (VALUES
        ('business_context_versions'),('business_context_approvals'),
        ('landing_page_snapshots'),('landing_page_approvals')
      )
      SELECT
        (SELECT count(*)::int FROM governed
          WHERE has_table_privilege('service_role','public.' || table_name,'SELECT')) service_select_count,
        (SELECT count(*)::int FROM governed CROSS JOIN (VALUES ('authenticated'),('anon')) roles(role_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) browser_select_count,
        (SELECT count(*)::int FROM pg_class c JOIN governed g ON g.table_name=c.relname
          WHERE c.relnamespace='public'::regnamespace AND c.relrowsecurity) rls_count
    `)
    expect(matrix).toEqual({ service_select_count: 4, browser_select_count: 0, rls_count: 4 })
  })

  it('keeps every governed function search path out of the writable public schema', async () => {
    const functions = await callOne<{ total: number; unsafe: number }>(`
      SELECT count(*)::int total,
             count(*) FILTER (
               WHERE array_to_string(COALESCE(proconfig, ARRAY[]::text[]), ',') LIKE '%public%'
             )::int unsafe
        FROM pg_proc
       WHERE pronamespace='public'::regnamespace
         AND proname IN (
           'governed_context_append_only_guard',
           'commit_business_context_version',
           'commit_landing_page_snapshot',
           'approve_business_context_version',
           'withdraw_business_context_approval',
           'approve_landing_page_snapshot',
           'withdraw_landing_page_approval',
           'read_governed_planning_context'
         )
    `)
    expect(functions).toEqual({ total: 8, unsafe: 0 })
  })
})
