import { readdirSync } from 'node:fs'
import type { CheckResult } from '../../src/lib/setup/types'

// Is every file in supabase/migrations applied? The REST schema check (src/lib/setup/schema-markers.ts)
// reads marker TABLES, so it cannot see a migration that only replaces a function or alters a table:
// 0002_record_conversion_delivery_serialize.sql is one. The Supabase CLI records each migration it applies
// in supabase_migrations.schema_migrations (`version` = the file name's leading digits), which is not
// exposed over REST. So this check needs a database connection: SUPABASE_DB_URL, the same variable
// `npm run setup -- --apply-schema` uses, read for this run and never saved or printed.

export interface MigrationFile { file: string; version: string | null }

export type LedgerRead =
  | { kind: 'applied'; versions: string[] }
  | { kind: 'no_ledger' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'not_configured' }

/** The CLI's own file-name rule: `<digits>_<name>.sql`; it skips any other file. */
const MIGRATION_NAME = /^(\d+)_.*\.sql$/

export function listMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
    .map((file) => ({ file, version: MIGRATION_NAME.exec(file)?.[1] ?? null }))
}

const TITLE = 'Every migration applied'
const PUSH = 'Apply the missing migrations: npm run setup -- --apply-schema (with SUPABASE_DB_URL), or supabase db push.'

export function migrationLedgerCheck(files: readonly MigrationFile[], read: LedgerRead): CheckResult {
  const base = { id: 'supabase.migrations', integration: 'supabase' as const, title: TITLE }
  if (read.kind === 'not_configured') {
    return { ...base, level: 'skip', detail: `Not checked: the schema check reads marker tables, which do not show a migration that only changes functions or columns. Set SUPABASE_DB_URL for this run (it is not saved) to compare all ${files.length} files in supabase/migrations with the database's migration history.` }
  }
  if (read.kind === 'unreadable') {
    return { ...base, level: 'fail', detail: `Could not read the migration history: ${read.reason}.`, fix: 'Check SUPABASE_DB_URL (Project Settings → Database → connection string).' }
  }
  if (read.kind === 'no_ledger') {
    return { ...base, level: 'warn', detail: 'The database has no supabase_migrations.schema_migrations table, so which migrations ran cannot be verified (the schema was not applied with the Supabase CLI).', fix: PUSH }
  }
  const applied = new Set(read.versions)
  const missing = files.filter((m) => m.version === null || !applied.has(m.version)).map((m) => m.file)
  return missing.length === 0
    ? { ...base, level: 'ok', detail: `All ${files.length} files in supabase/migrations are in the database's migration history.` }
    : { ...base, level: 'fail', detail: `Not applied: ${missing.join(', ')} (${missing.length} of ${files.length} files in supabase/migrations).`, fix: PUSH }
}

/** Reads the applied versions with `pg` (a development dependency, present wherever the doctor runs). */
export async function readAppliedVersions(dbUrl: string): Promise<string[] | 'no_ledger'> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    const exists = await client.query<{ present: boolean }>("select to_regclass('supabase_migrations.schema_migrations') is not null as present")
    if (!exists.rows[0]?.present) return 'no_ledger'
    const rows = await client.query<{ version: string }>('select version from supabase_migrations.schema_migrations')
    return rows.rows.map((row) => String(row.version))
  } finally {
    await client.end()
  }
}

/** The ledger read for the doctor: never throws, and never includes the connection string. */
export async function readLedger(dbUrl: string | undefined, read: (dbUrl: string) => Promise<string[] | 'no_ledger'>): Promise<LedgerRead> {
  if (!dbUrl) return { kind: 'not_configured' }
  try {
    const versions = await read(dbUrl)
    return versions === 'no_ledger' ? { kind: 'no_ledger' } : { kind: 'applied', versions }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { kind: 'unreadable', reason: typeof code === 'string' ? `database error ${code}` : 'the connection failed' }
  }
}
