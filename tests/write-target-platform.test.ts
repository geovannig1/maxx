import { describe, expect, it, vi } from 'vitest'
import { resolveWriteTargetContext } from '@/lib/writes/write-preconditions'
import { currencyMismatch } from '@/lib/writes/write-currency'

vi.mock('@/config/business-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/business-config')>()),
  accountCurrency: () => 'USD',
}))

// The governed write path checks the target account's own platform (ad_accounts.platform) at its entry
// gate and refuses an account on any platform other than the one the write path implements (Meta).

function db(account: Record<string, unknown>) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === 'ad_accounts' ? account : { id: 'local-adset' }, error: null }),
      }
      return chain
    },
  } as unknown as Parameters<typeof resolveWriteTargetContext>[0]
}

const resolve = (account: Record<string, unknown>) =>
  resolveWriteTargetContext(db(account), 'acct-1', 'pause_ad', 'ad', '123456', {})

describe('resolveWriteTargetContext: account platform', () => {
  it('binds a target on a Meta account', async () => {
    await expect(resolve({ account_id: 'act_123', is_active: true, currency: 'USD', platform: 'meta' }))
      .resolves.toMatchObject({ ok: true })
  })

  it('refuses an account whose platform is unknown or missing, before any network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const platform of ['google', undefined, null]) {
      await expect(resolve({ account_id: 'act_123', is_active: true, currency: 'USD', platform }), String(platform))
        .resolves.toMatchObject({ ok: false, status: 'PRECONDITION_UNAVAILABLE', message: expect.stringMatching(/Meta ad accounts only/) })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('currencyMismatch uses the given platform budget units', () => {
  it('refuses a currency the units do not support, accepts one they do', () => {
    expect(currencyMismatch('USD', { supports: () => false })).toMatch(/does not list USD/)
    expect(currencyMismatch('USD', { supports: () => true })).toBeNull()
  })
})
