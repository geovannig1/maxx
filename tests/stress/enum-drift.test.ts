import { describe, it, expect, beforeAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { freshSchemaDb } from '../db/schema-db'

// Permanent regression guard for the enum-drift bug class: health-monitor.ts inserted the
// alert_type value 'pixel_health' BEFORE a migration added it to the enum, so every pixel-health alert
// insert silently failed (caught, non-fatal) for as long as the drift existed. This test reads the
// alert_type enum's legal values from the shipped schema's live catalog and asserts that every
// `alert_type: '...'` literal written anywhere in src/ is one of them — so shipping a code literal ahead
// of its migration turns RED here instead of failing silently in prod.

const ROOT = process.cwd()
const SRC_DIR = join(ROOT, 'src')

/** Legal alert_type values, read from the enum the shipped migrations actually create. */
async function alertTypeValuesFromSchema(): Promise<Set<string>> {
  const db = await freshSchemaDb()
  try {
    const { rows } = await db.query<{ value: string }>(`SELECT unnest(enum_range(NULL::public.alert_type))::text AS value`)
    return new Set(rows.map((row) => row.value))
  } finally {
    await db.close()
  }
}

/** Every distinct `alert_type: '...'` literal written in src/, with the file it appears in. */
function alertTypeLiteralsInSrc(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.tsx?$/.test(entry)) continue
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/alert_type:\s*'([a-z_]+)'/g)) {
        const rel = p.slice(ROOT.length + 1)
        found.set(m[1], [...(found.get(m[1]) ?? []), rel])
      }
    }
  }
  walk(SRC_DIR)
  return found
}

describe('enum drift guard — alert_type (pixel_health class)', () => {
  let legal = new Set<string>()
  beforeAll(async () => { legal = await alertTypeValuesFromSchema() })
  const literals = alertTypeLiteralsInSrc()

  it('parses a non-trivial enum from the migrations', () => {
    // Sanity: the catalog read actually found the enum (guards against a silently-empty legal set that would
    // make every assertion below vacuously pass).
    expect(legal.size).toBeGreaterThanOrEqual(10)
    expect(legal.has('spend_spike')).toBe(true)
    expect(legal.has('champion_candidate')).toBe(true) // baseline enum value
    expect(legal.has('data_drift')).toBe(true) // baseline enum value
    expect(legal.has('pixel_health')).toBe(true) // the bug that motivated this guard
  })

  it('found alert_type literals to check', () => {
    expect(literals.size).toBeGreaterThan(0)
  })

  it('every alert_type literal written in src has a migration that defines it', () => {
    const orphans: string[] = []
    for (const [value, files] of literals) {
      if (!legal.has(value)) orphans.push(`'${value}' (in ${files.join(', ')})`)
    }
    expect(orphans, `alert_type literal(s) with no enum migration — will silently fail on insert:\n${orphans.join('\n')}`).toEqual([])
  })
})
