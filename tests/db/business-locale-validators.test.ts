import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { fixtureUuid, freshSchemaDb } from './schema-db'

// the database validators read the ad account's own timezone and currency instead of
// pinning 'America/New_York' and 'USD'.

const EASTERN = fixtureUuid(1)
const BERLIN = fixtureUuid(2)

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const scope = (accountId: string, timezone: string, currency: string) => canonical({
  version: 1, policyVersion: 'reporting-v1', source: 'business', accountId, metaAccountId: 'act_123',
  requestedRange: { from: '2026-06-08', to: '2026-06-14' }, range: { from: '2026-06-08', to: '2026-06-14' },
  comparison: { from: '2026-06-01', to: '2026-06-07' }, timezone, currency, detailIds: [],
})

describe('reporting scope validator uses the account timezone and currency', () => {
  let db: PGlite
  beforeAll(async () => {
    db = await freshSchemaDb()
    await db.query(`INSERT INTO public.ad_accounts (id, account_id, account_name, timezone_name, currency, is_active)
      VALUES ($1, 'act_1', 'Eastern', 'America/New_York', 'USD', true), ($2, 'act_2', 'Berlin', 'Europe/Berlin', 'EUR', false)`,
    [EASTERN, BERLIN])
  })
  afterAll(async () => db.close())

  const validate = (text: string) => db.query('SELECT public.validate_reporting_refresh_scope($1) AS v', [text])

  it('accepts an Eastern/USD scope for an Eastern/USD account (unchanged behaviour, control)', async () => {
    await expect(validate(scope(EASTERN, 'America/New_York', 'USD'))).resolves.toBeTruthy()
  })

  it('accepts a Berlin/EUR scope for a Berlin/EUR account', async () => {
    const result = await validate(scope(BERLIN, 'Europe/Berlin', 'EUR'))
    expect((result.rows[0] as { v: { timezone: string } }).v.timezone).toBe('Europe/Berlin')
  })

  it('refuses a scope in another zone or currency than its account', async () => {
    await expect(validate(scope(BERLIN, 'America/New_York', 'USD'))).rejects.toThrow(/does not match the ad account/)
    await expect(validate(scope(BERLIN, 'Europe/Berlin', 'USD'))).rejects.toThrow(/does not match the ad account/)
    await expect(validate(scope(EASTERN, 'Europe/Berlin', 'USD'))).rejects.toThrow(/does not match the ad account/)
  })

  it('refuses a scope for an account that does not exist', async () => {
    await expect(validate(scope(fixtureUuid(9), 'America/New_York', 'USD'))).rejects.toThrow(/does not match the ad account/)
  })
})
