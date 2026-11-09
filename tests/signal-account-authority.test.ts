import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('expert signal account and action authority', () => {
  it('scopes live signal reads to the resolved account and withholds stored action prose', () => {
    const route = fs.readFileSync('src/app/api/signals/route.ts', 'utf8')
    const page = fs.readFileSync('src/app/(dashboard)/signals/page.tsx', 'utf8')
    expect(route).toMatch(/resolveOnlyActiveAccount\(db\)/)
    expect(route.match(/\.eq\('ad_account_id', adAccountId\)/g)).toHaveLength(2)
    expect(route).not.toMatch(/select\('\*|suggested_action/)
    expect(page).not.toMatch(/suggested_action|>Action:</)
  })

  it('manual evidence cannot inject a stored action and uses exact account ownership', () => {
    const route = fs.readFileSync('src/app/api/signals/manual/route.ts', 'utf8')
    expect(route).toMatch(/resolveOnlyActiveAccount\(db\)/)
    expect(route).toMatch(/ad_account_id: activeAccount\.account\.id/)
    expect(route).toMatch(/suggested_action: null/)
    expect(route).not.toMatch(/body\.suggested_action|META_AD_ACCOUNT_ID/)
  })

  it('seeds sources only after exact active-account resolution', () => {
    const route = fs.readFileSync('src/app/api/signals/seed/route.ts', 'utf8')
    expect(route).toMatch(/resolveOnlyActiveAccount\(db\)/)
    expect(route).toMatch(/\.eq\('ad_account_id', adAccountDbId\)/)
    expect(route).not.toMatch(/META_AD_ACCOUNT_ID|\.or\(`/)
    expect(route).toMatch(/if \(existingError\)/)
  })
})
