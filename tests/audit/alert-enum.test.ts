import { describe, it, expect, beforeAll } from 'vitest'
import { ALL_ALERT_TYPES } from '@/types/db'
import { freshSchemaDb } from '../db/schema-db'

// Alert-type drift guard (audit finding 24F). The Postgres `alert_type` enum is the source of truth;
// if code emits a value the enum doesn't have, the whole BATCHED alert insert silently fails (this
// already happened twice before the squash). This test reads the enum from the shipped schema's
// live catalog and asserts the TS union/list (ALL_ALERT_TYPES, which tsc pins to the AlertType union)
// matches the DB enum exactly.

async function dbAlertEnumFromSchema(): Promise<Set<string>> {
  const db = await freshSchemaDb()
  try {
    const { rows } = await db.query<{ value: string }>(`SELECT unnest(enum_range(NULL::public.alert_type))::text AS value`)
    return new Set(rows.map((row) => row.value))
  } finally {
    await db.close()
  }
}

describe('alert_type enum: code union stays in sync with the DB (no silent insert drift)', () => {
  let db = new Set<string>()
  beforeAll(async () => { db = await dbAlertEnumFromSchema() })

  it('the migrations actually define the alert_type enum', () => {
    expect(db.size).toBeGreaterThan(0)
  })

  it('every DB enum value is present in the AlertType union (ALL_ALERT_TYPES)', () => {
    const code = new Set<string>(ALL_ALERT_TYPES)
    const missingInCode = [...db].filter((v) => !code.has(v))
    expect(missingInCode, `DB alert_type values missing from the AlertType union: ${missingInCode.join(', ')}`).toEqual([])
  })

  it('every AlertType union value exists in the DB enum (no phantom types)', () => {
    const missingInDb = ALL_ALERT_TYPES.filter((v) => !db.has(v))
    expect(missingInDb, `AlertType union values with no matching DB enum value: ${missingInDb.join(', ')}`).toEqual([])
  })
})
