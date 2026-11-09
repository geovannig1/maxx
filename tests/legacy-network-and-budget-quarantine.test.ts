import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ email: 'owner@example.com' as string | null }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: auth.email ? { email: auth.email } : null } }) },
  })),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))

import { GET as getLegacyBudgetActions } from '@/app/api/recommendations/actions/route'
import { POST as lookupCompetitor } from '@/app/api/competitors/lookup/route'

describe('legacy network and budget paths are quarantined', () => {
  beforeEach(() => { auth.email = 'owner@example.com' })

  it('does not run the independent budget-reallocation brain', async () => {
    const response = await getLegacyBudgetActions()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'CAMPAIGN_PLAN_REQUIRED',
      authority_tier: 'diagnostic_only',
    })
  })

  it('does not perform an owner-supplied outbound competitor fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await lookupCompetitor(new Request('http://localhost/api/competitors/lookup', { method: 'POST' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'SAFE_LOOKUP_REQUIRED' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('removes the unbound Meta account id from owner surfaces', () => {
    const pages = [
      'src/app/(dashboard)/performance/campaigns/page.tsx',
      'src/app/(dashboard)/performance/adsets/page.tsx',
    ].map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    expect(pages).not.toMatch(/act=100000000000777/)
  })
})
