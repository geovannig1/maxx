import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../scripts/lib/doctor-cli'
import { listMigrationFiles, migrationLedgerCheck, type MigrationFile } from '../scripts/lib/migration-ledger'
import { fakeFetch, fakeState } from './helpers/fake-services'

// The doctor's schema check reads marker TABLES through the REST API, so it cannot see a migration that
// only replaces a function (0002_record_conversion_delivery_serialize.sql does exactly that). With
// SUPABASE_DB_URL the doctor compares every file in supabase/migrations with the CLI's ledger,
// supabase_migrations.schema_migrations; without it, it says that this comparison did not run.

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations')
const FILES: MigrationFile[] = [{ file: '0001_baseline.sql', version: '0001' }, { file: '0002_fix.sql', version: '0002' }]
const DB_URL = 'postgresql://postgres:planted-db-password-0123@db.example.test:5432/postgres'

describe('migration files', () => {
  it('lists every .sql file in supabase/migrations with its CLI version', () => {
    const onDisk = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
    const listed = listMigrationFiles(MIGRATIONS)
    expect(listed.map((m) => m.file)).toEqual(onDisk)
    expect(listed).toContainEqual({ file: '0002_record_conversion_delivery_serialize.sql', version: '0002' })
  })
})

describe('migration ledger check', () => {
  it('passes only when every file version is in the ledger', () => {
    expect(migrationLedgerCheck(FILES, { kind: 'applied', versions: ['0001', '0002'] }).level).toBe('ok')
    const behind = migrationLedgerCheck(FILES, { kind: 'applied', versions: ['0001'] })
    expect(behind.level).toBe('fail')
    expect(behind.detail).toContain('0002_fix.sql')
    expect(behind.detail).not.toContain('0001_baseline.sql')
    expect(behind.fix).toMatch(/db push/)
  })

  it('cannot verify without a ledger, and says why instead of passing', () => {
    expect(migrationLedgerCheck(FILES, { kind: 'no_ledger' }).level).toBe('warn')
    expect(migrationLedgerCheck(FILES, { kind: 'unreadable', reason: 'connection refused' }).level).toBe('fail')
    const skipped = migrationLedgerCheck(FILES, { kind: 'not_configured' })
    expect(skipped.level).toBe('skip')
    expect(skipped.detail).toContain('SUPABASE_DB_URL')
  })
})

function doctor(argv: string[], env: Record<string, string | undefined>, applied: string[]) {
  const out: string[] = []
  const readApplied = vi.fn(async () => applied)
  const run = runDoctor(argv, {
    env, readEnvFile: () => null, envFilePath: '/tmp/fixture/.env.local',
    fetch: fakeFetch(fakeState(), []), nodeVersion: '24.1.0',
    stdout: (line) => out.push(line), stderr: (line) => out.push(line),
    migrations: { list: () => FILES, readApplied },
  })
  return { run, out, readApplied }
}

describe('npm run doctor and the migration ledger', () => {
  it('fails and names the unapplied file when SUPABASE_DB_URL shows the ledger behind', async () => {
    const { run, out, readApplied } = doctor(['--json', '--only=supabase'], { SUPABASE_DB_URL: DB_URL }, ['0001'])
    expect(await run).toBe(1)
    expect(readApplied).toHaveBeenCalledWith(DB_URL)
    const doc = JSON.parse(out[0]) as { checks: Array<{ id: string; level: string; detail: string }> }
    const check = doc.checks.find((c) => c.id === 'supabase.migrations')!
    expect(check.level).toBe('fail')
    expect(check.detail).toContain('0002_fix.sql')
    expect(out.join('\n')).not.toContain('planted-db-password-0123')
  })

  it('passes the ledger check when every file is applied', async () => {
    const { run, out } = doctor(['--json', '--only=supabase'], { SUPABASE_DB_URL: DB_URL }, ['0001', '0002'])
    await run
    const doc = JSON.parse(out[0]) as { checks: Array<{ id: string; level: string }> }
    expect(doc.checks.find((c) => c.id === 'supabase.migrations')?.level).toBe('ok')
  })

  it('does not connect offline or without SUPABASE_DB_URL, and reports the check as not run', async () => {
    const offline = doctor(['--json', '--offline'], { SUPABASE_DB_URL: DB_URL }, [])
    await offline.run
    expect(offline.readApplied).not.toHaveBeenCalled()
    const unset = doctor(['--json', '--only=supabase'], {}, [])
    await unset.run
    expect(unset.readApplied).not.toHaveBeenCalled()
    const doc = JSON.parse(unset.out[0]) as { checks: Array<{ id: string; level: string }> }
    expect(doc.checks.find((c) => c.id === 'supabase.migrations')?.level).toBe('skip')
  })

  it('leaves the ledger out when another integration is selected', async () => {
    const { run, out, readApplied } = doctor(['--json', '--only=ai'], { SUPABASE_DB_URL: DB_URL }, [])
    await run
    expect(readApplied).not.toHaveBeenCalled()
    expect(out[0]).not.toContain('supabase.migrations')
  })
})
