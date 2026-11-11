import { describe, expect, it } from 'vitest'
import {
  AccountPlatformUnavailableError,
  adPlatformForAccount,
  loadAccountPlatform,
  loadActiveAccountPlatform,
} from '@/lib/platforms/account-platform'
import { UnknownAdPlatformError, getAdPlatform } from '@/lib/platforms/registry'

// The single resolver from an ad account to its platform. It reads the account's `platform` column
// (migration 0003) and fails closed: an unregistered, missing or malformed value is an error, never Meta.

type Result = { data: unknown; error: { message: string } | null }

/** A minimal Supabase stand-in recording the query it was asked for. */
function fakeDb(result: Result) {
  const calls: string[] = []
  const chain = {
    select(cols: string) { calls.push(`select(${cols})`); return chain },
    eq(col: string, value: unknown) { calls.push(`eq(${col},${String(value)})`); return chain },
    limit(n: number) { calls.push(`limit(${n})`); return Promise.resolve(result) },
    maybeSingle() { calls.push('maybeSingle'); return Promise.resolve(result) },
  }
  const db = { from(table: string) { calls.push(`from(${table})`); return chain } }
  return { db: db as unknown as Parameters<typeof loadAccountPlatform>[0], calls }
}

describe('adPlatformForAccount', () => {
  it('returns the registered platform named by the account', () => {
    expect(adPlatformForAccount({ platform: 'meta' })).toBe(getAdPlatform('meta'))
  })

  it('fails closed on an unregistered, missing or malformed platform', () => {
    for (const platform of ['google', 'Meta', '', 'constructor', '__proto__', null, undefined, 1]) {
      expect(() => adPlatformForAccount({ platform }), String(platform)).toThrow(UnknownAdPlatformError)
    }
    expect(() => adPlatformForAccount(null)).toThrow(UnknownAdPlatformError)
    expect(() => adPlatformForAccount({})).toThrow(UnknownAdPlatformError)
  })
})

describe('loadAccountPlatform', () => {
  it('reads the platform of the account by its database id', async () => {
    const { db, calls } = fakeDb({ data: { platform: 'meta' }, error: null })
    await expect(loadAccountPlatform(db, 'acct-1')).resolves.toBe(getAdPlatform('meta'))
    expect(calls).toEqual(['from(ad_accounts)', 'select(platform)', 'eq(id,acct-1)', 'maybeSingle'])
  })

  it('throws when the account is missing or unreadable, and on an unknown platform', async () => {
    await expect(loadAccountPlatform(fakeDb({ data: null, error: null }).db, 'x')).rejects.toThrow(AccountPlatformUnavailableError)
    await expect(loadAccountPlatform(fakeDb({ data: null, error: { message: 'down' } }).db, 'x')).rejects.toThrow(AccountPlatformUnavailableError)
    await expect(loadAccountPlatform(fakeDb({ data: { platform: 'google' }, error: null }).db, 'x')).rejects.toThrow(UnknownAdPlatformError)
  })
})

describe('loadActiveAccountPlatform', () => {
  it('reads the platform of the only active account', async () => {
    const { db, calls } = fakeDb({ data: [{ platform: 'meta' }], error: null })
    await expect(loadActiveAccountPlatform(db)).resolves.toBe(getAdPlatform('meta'))
    expect(calls).toEqual(['from(ad_accounts)', 'select(platform)', 'eq(is_active,true)', 'limit(2)'])
  })

  it('throws with no active account, two active accounts, or a read error', async () => {
    await expect(loadActiveAccountPlatform(fakeDb({ data: [], error: null }).db)).rejects.toThrow(AccountPlatformUnavailableError)
    await expect(loadActiveAccountPlatform(fakeDb({ data: [{ platform: 'meta' }, { platform: 'meta' }], error: null }).db))
      .rejects.toThrow(AccountPlatformUnavailableError)
    await expect(loadActiveAccountPlatform(fakeDb({ data: null, error: { message: 'down' } }).db)).rejects.toThrow(AccountPlatformUnavailableError)
  })
})
