import { afterAll, beforeAll, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { prepareParentHistoryDb } from './reporting-parent-history-fixture'
import { claimedJob, finish, jobSnapshot } from './reporting-refresh-fixture'

let db: PGlite
beforeAll(async () => { db = await prepareParentHistoryDb() })
afterAll(async () => { await db?.close() })

it('bounds only the final publication budget, preserving function authority and snapshot rejection', async () => {
  const functions = (await db.query<Record<string, unknown>>(`select proname,prosecdef,proconfig,
      has_function_privilege('service_role',oid,'EXECUTE') service_execute,
      has_function_privilege('authenticated',oid,'EXECUTE') authenticated_execute,
      has_function_privilege('anon',oid,'EXECUTE') anon_execute
    from pg_proc where pronamespace='public'::regnamespace and proname in
    ('finish_reporting_refresh','claim_reporting_refresh','publish_reporting_refresh_progress','fail_reporting_refresh') order by proname`)).rows
  const authority = { prosecdef: true, service_execute: true, authenticated_execute: false, anon_execute: false }
  expect(functions).toEqual(['claim_reporting_refresh', 'fail_reporting_refresh', 'finish_reporting_refresh',
    'publish_reporting_refresh_progress'].map(proname => ({ proname, ...authority,
    proconfig: proname === 'finish_reporting_refresh' ? ['search_path=pg_catalog, pg_temp', 'statement_timeout=20s'] : ['search_path=pg_catalog, pg_temp'] })))
  const job = await claimedJob(db)
  const snapshot = jobSnapshot(job)
  await expect(finish(db, job, { ...snapshot, scope: { ...snapshot.scope, currency: 'EUR' } }))
    .rejects.toMatchObject({ code: '23514' })
  expect(await finish(db, job)).toMatchObject({ committed: true, snapshot_id: expect.any(String) })
})
