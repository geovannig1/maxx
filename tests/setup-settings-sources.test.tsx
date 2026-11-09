import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// The setup checklist's Settings panel. Outcome sources belong to the ad account the first Meta sync
// stores, so a connected database without that account must say so, not "database not connected".

const state = vi.hoisted(() => ({ active: { ok: false, reason: 'not_found' } as Record<string, unknown> }))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone_name: 'America/New_York', currency: 'USD' } }) }) }) }) }),
}))
vi.mock('@/lib/accounts/active-account', () => ({ resolveOnlyActiveAccount: async () => state.active }))
vi.mock('@/lib/outcomes/source-admin', () => ({ listOutcomeSources: async () => [{ enabled: true }, { enabled: false }] }))

import { SetupSettings } from '@/components/setup/SetupSettings'

const render = async () => renderToStaticMarkup(await SetupSettings())

describe('setup settings: outcome sources', () => {
  beforeEach(() => { state.active = { ok: false, reason: 'not_found' } })

  it('names the missing ad account when the database answers but no account is stored yet', async () => {
    const html = await render()
    expect(html).toContain('after the first Meta sync')
    expect(html).not.toContain('until the database is connected')
  })

  it('keeps the database message when the account cannot be read at all', async () => {
    state.active = { ok: false, reason: 'unavailable' }
    expect(await render()).toContain('Unavailable until the database is connected')
  })

  it('control: a stored account shows how many sources are enabled', async () => {
    state.active = { ok: true, account: { id: 'a', accountId: 'act_1', accountName: null } }
    expect(await render()).toContain('1 of 2 enabled')
  })
})
