import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The one way a database test gets a schema: every file in supabase/migrations, in order, exactly as a
 * fresh install applies them. Tests must exercise the SHIPPED schema, never a hand-written subset of
 * it, so a test cannot pass against tables, columns, grants or triggers that production does not have.
 *
 * Building the schema takes ~0.5 s, so it is built once per worker and every test gets a fresh copy
 * restored from that snapshot.
 */
export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations')

export function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
}

/** Concatenated SQL of every shipped migration, for tests that assert on schema text. */
export function migrationSql(): string {
  return migrationFiles().map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n')
}

const SUPABASE_ROLES = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  -- As on Supabase: the service role bypasses row-level security (the app's server key).
  ALTER ROLE service_role BYPASSRLS;
`
const EXTENSIONS = { uuid_ossp, pgcrypto }

let snapshot: Promise<File | Blob> | null = null

async function buildSnapshot(): Promise<File | Blob> {
  const db = new PGlite({ extensions: EXTENSIONS })
  await db.exec(SUPABASE_ROLES)
  for (const file of migrationFiles()) {
    try {
      await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      throw new Error(`schema-db: migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const dump = await db.dumpDataDir('none')
  await db.close()
  return dump
}

/** A fresh, isolated database holding the full shipped schema and no rows. */
export async function freshSchemaDb(): Promise<PGlite> {
  snapshot ??= buildSnapshot()
  return new PGlite({ extensions: EXTENSIONS, loadDataDir: await snapshot })
}

/** Deterministic uuid for fixtures: fixtureUuid(7) → 00000000-0000-4000-8000-000000000007. */
export const fixtureUuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Insert a minimal, valid ad account (the parent of almost every row) and return its id. */
export async function insertAdAccount(db: PGlite, id: string, metaAccountId = `act_${id.slice(-12)}`): Promise<string> {
  await db.query(
    `INSERT INTO public.ad_accounts (id, account_id, account_name, timezone_name, is_active)
     VALUES ($1, $2, 'Example account', 'America/New_York', true)`,
    [id, metaAccountId],
  )
  return id
}
