import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEMO_ACCOUNT, demoCalendar, type DemoCalendar } from './sample/demo-account'
import { demoSeedSql } from './sample/demo-seed'

// The demo database: an in-memory PGlite with the SHIPPED schema (every file in supabase/migrations,
// in order, as a fresh install applies them) and a deterministic, fictional seed anchored to the day
// the demo starts (./sample/demo-seed.ts). Nothing is read from or written to any real service.
// Mirrors tests/db/schema-db.ts, which the DB tests own.

const SUPABASE_ROLES = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER ROLE service_role BYPASSRLS;
`

export const DEMO_ACCOUNT_ID = DEMO_ACCOUNT.id
export const DEMO_META_ACCOUNT = DEMO_ACCOUNT.metaAccountId

export async function createSampleDb(calendar: DemoCalendar = demoCalendar(), root = process.cwd()): Promise<PGlite> {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto } })
  await db.exec(SUPABASE_ROLES)
  const dir = path.join(root, 'supabase/migrations')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(path.join(dir, file), 'utf8'))
    } catch (error) {
      throw new Error(`demo: migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await db.exec(demoSeedSql(calendar))
  return db
}
