import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { COMMERCIAL_OBJECTIVE, insertActionDecision } from './decision-fixture'

const ACCOUNT = fixtureUuid(73)
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

describe('action-decision commercial-objective cutover', () => {
  it('raises the durable policy floor so delivery-objective v2 rows become legacy', async () => {
    const result = await db.query<{ floor: number }>(
      'SELECT public.action_decision_policy_floor() AS floor',
    )
    // The commercial-objective policy raised the floor to 3; v4 and v5 raised it further. The shipped floor
    // is 5, and the property the commercial-objective cutover established — delivery-objective v2 rows sit below it — still holds.
    expect(result.rows[0].floor).toBe(5)
    expect(result.rows[0].floor).toBeGreaterThan(2)
  })

  it('documents objective as the commercial objective, not Meta delivery configuration', async () => {
    const result = await db.query<{ comment: string | null }>(`
      SELECT pg_catalog.col_description('public.action_decisions'::regclass, a.attnum) AS comment
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='public.action_decisions'::regclass AND a.attname='objective'
    `)
    expect(result.rows[0].comment).toMatch(/commercial objective/i)
    expect(result.rows[0].comment).toMatch(/Meta campaign delivery objectives.*diagnostic/i)
  })

  it('rejects a current-policy row whose north star is a delivery or attribution proxy', async () => {
    await expect(insertActionDecision(db, ACCOUNT, {
      id: fixtureUuid(1), policy_version: 3, objective: 'bookings',
    })).rejects.toThrow(/action_decisions_v3_commercial_objective/i)

    await insertActionDecision(db, ACCOUNT, {
      id: fixtureUuid(2), policy_version: 3, objective: COMMERCIAL_OBJECTIVE,
    })
    const result = await db.query<{ objective: string }>(
      'SELECT objective FROM public.action_decisions WHERE policy_version=3',
    )
    expect(result.rows[0].objective)
      .toBe('maximize_incremental_contribution_from_ad_attributed_collected_revenue')
  })
})
