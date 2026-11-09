import fs from 'node:fs'
import path from 'node:path'
import type pg from 'pg'

// Several older integration suites blanket-GRANT tables to service_role for their own fixtures, and the
// suites share one local database. A suite that measures the production privilege contract first puts
// the contract back. Before the v1 release it re-applied two hardening migrations by file name; since the squash the
// contract lives only in the baseline, so it is read from there: every table, view and sequence loses
// all privileges for the API roles, then the baseline's own GRANTs to service_role are re-applied.
// Statements come from the shipped SQL file, never from a caller.

const BASELINE = path.resolve(process.cwd(), 'supabase/migrations/0001_baseline.sql')
const SHIPPED_GRANT = /^GRANT [A-Z, ]+ ON (?:TABLE|SEQUENCE) public\.[a-z0-9_]+ TO service_role;$/gm

/** The baseline's table and sequence GRANTs to service_role, exactly as shipped. */
export function shippedServiceRoleGrants(sql: string = fs.readFileSync(BASELINE, 'utf8')): string[] {
  return sql.match(SHIPPED_GRANT) ?? []
}

export async function reassertShippedPrivileges(client: pg.Client): Promise<void> {
  const grants = shippedServiceRoleGrants()
  // Instrument check: an empty or tiny list means the baseline shape changed, not that nothing is granted.
  if (grants.length < 50) throw new Error(`expected the baseline's service_role grants, found ${grants.length}`)
  await client.query('BEGIN')
  try {
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role')
    await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role')
    for (const grant of grants) await client.query(grant)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
