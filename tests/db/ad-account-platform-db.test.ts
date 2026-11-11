import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

// Migration 0004: an ad account records its ad platform (NOT NULL, default 'meta', only registered
// platforms) and, optionally, its ISO 3166-1 alpha-2 country. Privileges stay service-role only.

const ACCOUNT = '00000000-0000-4000-8000-0000000004a1'
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
})

const update = (column: string, value: unknown) =>
  db.query(`UPDATE public.ad_accounts SET ${column} = $1 WHERE id = $2`, [value, ACCOUNT])

describe('ad_accounts.platform', () => {
  it('defaults an existing-style insert to meta', async () => {
    await insertAdAccount(db, ACCOUNT)
    const { rows } = await db.query<{ platform: string; country: string | null }>(
      'SELECT platform, country FROM public.ad_accounts WHERE id = $1', [ACCOUNT])
    expect(rows).toEqual([{ platform: 'meta', country: null }])
  })

  it('refuses a platform that is not registered, a null and an empty value', async () => {
    await insertAdAccount(db, ACCOUNT)
    await expect(update('platform', 'google')).rejects.toThrow(/ad_accounts_platform_check/)
    await expect(update('platform', 'Meta')).rejects.toThrow(/ad_accounts_platform_check/)
    await expect(update('platform', '')).rejects.toThrow(/ad_accounts_platform_check/)
    await expect(update('platform', null)).rejects.toThrow(/null value/)
  })

  it('accepts the registered platform explicitly (control)', async () => {
    await insertAdAccount(db, ACCOUNT)
    await expect(update('platform', 'meta')).resolves.toBeDefined()
  })
})

describe('ad_accounts.country', () => {
  it('accepts an upper-case alpha-2 code and null', async () => {
    await insertAdAccount(db, ACCOUNT)
    await update('country', 'GB')
    expect((await db.query<{ country: string }>('SELECT country FROM public.ad_accounts')).rows[0].country).toBe('GB')
    await update('country', null)
    expect((await db.query<{ country: string | null }>('SELECT country FROM public.ad_accounts')).rows[0].country).toBeNull()
  })

  it('refuses lower case, three letters, digits, whitespace and the empty string', async () => {
    await insertAdAccount(db, ACCOUNT)
    for (const bad of ['gb', 'GBR', 'G1', ' GB', 'GB ', '', 'G']) {
      await expect(update('country', bad), bad).rejects.toThrow(/ad_accounts_country_check/)
    }
  })
})

describe('privileges', () => {
  it('keeps the table service-role only: browser roles hold no column privileges on the new columns', async () => {
    const { rows } = await db.query<{ grantee: string; column_name: string }>(`
      SELECT grantee, column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'ad_accounts'
         AND column_name IN ('platform', 'country') AND grantee IN ('anon', 'authenticated')`)
    expect(rows).toEqual([])
    const service = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'ad_accounts'
         AND column_name IN ('platform', 'country') AND grantee = 'service_role' AND privilege_type = 'UPDATE'`)
    expect(service.rows[0].n).toBe(2)
  })
})
