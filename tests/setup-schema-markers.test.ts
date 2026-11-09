import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SCHEMA_MARKER_TABLES, missingMarkers } from '@/lib/setup/schema-markers'

// The doctor proves "schema applied" through marker tables (src/lib/setup/schema-markers.ts). Markers
// name tables, not migration files. Population: every migration in supabase/migrations that creates a
// table must have at least one of its tables as a marker, so a new migration cannot ship invisible to
// the doctor; and every marker must be a table some migration creates.

const CREATE_TABLE = /^CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_][a-z0-9_]*)/gim

function tablesByMigration(dir: string): Map<string, string[]> {
  return new Map(readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((file) =>
    [file, [...readFileSync(path.join(dir, file), 'utf8').matchAll(CREATE_TABLE)].map((m) => m[1])]))
}

function markerGaps(dir: string, markers: readonly string[]): string[] {
  const byMigration = tablesByMigration(dir)
  const created = new Set([...byMigration.values()].flat())
  return [
    ...[...byMigration].filter(([, tables]) => tables.length > 0 && !tables.some((t) => markers.includes(t)))
      .map(([file, tables]) => `${file}: creates ${tables.join(', ')} but none is a marker`),
    ...markers.filter((m) => !created.has(m)).map((m) => `marker ${m} is not a table any migration creates`),
  ]
}

const temp = mkdtempSync(path.join(tmpdir(), 'maxx-markers-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

describe('schema markers', () => {
  it('control: a planted migration that creates a table without a marker, and a stale marker, are reported', () => {
    const dir = path.join(temp, 'migrations')
    mkdirSync(dir)
    writeFileSync(path.join(dir, '20990101000000_planted.sql'), 'CREATE TABLE public.planted_table (id int);\n')
    writeFileSync(path.join(dir, '20990102000000_alter_only.sql'), 'ALTER TABLE public.planted_table ADD COLUMN x int;\n')
    expect(markerGaps(dir, [])).toEqual(['20990101000000_planted.sql: creates planted_table but none is a marker'])
    expect(markerGaps(dir, ['planted_table'])).toEqual([])
    expect(markerGaps(dir, ['planted_table', 'other'])).toEqual(['marker other is not a table any migration creates'])
  })

  it('every shipped migration that creates a table has a marker, and every marker is a shipped table', () => {
    const dir = path.resolve(__dirname, '../supabase/migrations')
    expect(markerGaps(dir, SCHEMA_MARKER_TABLES)).toEqual([])
  })

  it('reports the missing markers from an OpenAPI description, all of them when it is unreadable', () => {
    expect(missingMarkers({ paths: Object.fromEntries(SCHEMA_MARKER_TABLES.map((t) => [`/${t}`, {}])) })).toEqual([])
    expect(missingMarkers({ paths: { '/ad_accounts': {} } })).not.toContain('ad_accounts')
    expect(missingMarkers({ paths: { '/ad_accounts': {} } })).toEqual(SCHEMA_MARKER_TABLES.slice(1))
    expect(missingMarkers(null)).toEqual(SCHEMA_MARKER_TABLES)
  })
})
