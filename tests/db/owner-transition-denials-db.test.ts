import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OWNER_TRANSITION_DENIALS, OWNER_TRANSITION_RPC } from '@/lib/authority/owner-transition-denials'
import { freshSchemaDb } from './schema-db'

// The decision route shows the owner a database refusal only when it equals one of
// OWNER_TRANSITION_DENIALS. The list must be exactly what the shipped function raises: a missing entry
// would hide a guard refusal behind a generic error, and an extra one would pass unknown text through.

let db: PGlite
beforeAll(async () => { db = await freshSchemaDb() })
afterAll(async () => { await db?.close() })

async function raisedMessages(functionName: string): Promise<string[]> {
  const { rows } = await db.query<{ definition: string }>(
    `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`, [functionName])
  expect(rows, `${functionName} definitions`).toHaveLength(1)
  return [...rows[0].definition.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"))
}

describe('owner transition denial list', () => {
  it('control: the instrument reads RAISE EXCEPTION messages from a shipped function', async () => {
    expect(await raisedMessages('commit_variable_cost_batch')).not.toHaveLength(0)
  })

  it('equals the messages commit_recommendation_owner_transition raises', async () => {
    const raised = await raisedMessages(OWNER_TRANSITION_RPC)
    expect([...raised].sort()).toEqual([...OWNER_TRANSITION_DENIALS].sort())
  })

  it('every listed message is raised by the function exactly as the route sees it', async () => {
    const account = '00000000-0000-4000-8000-0000000000a1'
    await expect(db.query(
      `SELECT * FROM public.${OWNER_TRANSITION_RPC}($1,$2,'account','pause','not-a-decision',NULL,NULL,false,NULL,NULL)`,
      [account, account],
    )).rejects.toMatchObject({ message: 'invalid recommendation owner transition' })
    await expect(db.query(
      `SELECT * FROM public.${OWNER_TRANSITION_RPC}($1,$2,'account','pause','ignored',NULL,NULL,false,NULL,NULL)`,
      [account, account],
    )).rejects.toMatchObject({ message: 'recommendation is missing or cross-account' })
  })
})
