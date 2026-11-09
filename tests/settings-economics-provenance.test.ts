import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeResolution: {
    ok: true as boolean,
    account: { id: 'account-1', accountName: 'Example Studio' },
  } as { ok: true; account: { id: string; accountName: string | null } } | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  setting: { data: null as Record<string, unknown> | null, error: null as { message: string } | null },
  adminCalls: 0,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => state.activeResolution,
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => {
    state.adminCalls += 1
    return {
      from: (table: string) => {
        if (table === 'app_settings') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => state.setting }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
    }
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: 'owner@example.com' } } }) },
  }),
}))

vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('economics input provenance fails closed', () => {
  beforeEach(() => {
    state.activeResolution = { ok: true, account: { id: 'account-1', accountName: 'Example Studio' } }
    state.setting = { data: null, error: null }
    state.adminCalls = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns unavailable rather than a built-in AOV when no active account exists', async () => {
    state.activeResolution = { ok: false, reason: 'not_found' }
    const { loadEconomicsInputs } = await import('@/lib/economics/settings')

    await expect(loadEconomicsInputs()).resolves.toMatchObject({
      status: 'unavailable',
      inputs: null,
      reason_code: 'account_not_found',
      provenance: null,
    })
  })

  it.each(['ambiguous', 'unavailable'] as const)('keeps %s active-account ownership unavailable', async (reason) => {
    state.activeResolution = { ok: false, reason }
    const { loadEconomicsInputs } = await import('@/lib/economics/settings')

    await expect(loadEconomicsInputs()).resolves.toMatchObject({
      status: 'unavailable',
      inputs: null,
      reason_code: `account_${reason}`,
      provenance: null,
    })
  })

  it('distinguishes not configured, read failure, invalid JSON, and invalid values', async () => {
    const { loadEconomicsInputs } = await import('@/lib/economics/settings')

    await expect(loadEconomicsInputs()).resolves.toMatchObject({
      status: 'unavailable', inputs: null, reason_code: 'not_configured',
    })

    state.setting = { data: null, error: { message: 'database unavailable' } }
    await expect(loadEconomicsInputs()).resolves.toMatchObject({
      status: 'unavailable', inputs: null, reason_code: 'settings_read_failed',
    })

    state.setting = { data: { value: '{bad json', updated_at: '2026-07-30T12:00:00Z' }, error: null }
    await expect(loadEconomicsInputs()).resolves.toMatchObject({
      status: 'unavailable', inputs: null, reason_code: 'invalid_json',
    })

    state.setting = {
      data: {
        value: JSON.stringify({ aov: -1, gross_margin_rate: null, repeat_rate: null, source_note: 'bad' }),
        updated_at: '2026-07-30T12:00:00Z',
      },
      error: null,
    }
    await expect(loadEconomicsInputs()).resolves.toMatchObject({
      status: 'unavailable', inputs: null, reason_code: 'invalid_values',
    })
  })

  it('labels a valid stored value as unversioned and never invents approval provenance', async () => {
    state.setting = {
      data: {
        value: JSON.stringify({ aov: 220, gross_margin_rate: 0.55, repeat_rate: null, source_note: 'Manual estimate' }),
        updated_at: '2026-07-30T12:00:00Z',
      },
      error: null,
    }
    const { loadEconomicsInputs } = await import('@/lib/economics/settings')

    await expect(loadEconomicsInputs()).resolves.toEqual({
      status: 'available',
      inputs: { aov: 220, gross_margin_rate: 0.55, repeat_rate: null, source_note: 'Manual estimate' },
      reason_code: null,
      unavailable_reason: null,
      provenance: {
        source: 'app_settings.economics_inputs',
        status: 'unversioned_app_setting',
        updated_at: '2026-07-30T12:00:00Z',
        owner_approval_recorded: false,
        version_recorded: false,
      },
    })
  })

  it('requires an explicit AOV and source note for a first write and uses no commercial default', async () => {
    const { prepareEconomicsInputsUpdate } = await import('@/lib/economics/settings')

    expect(prepareEconomicsInputsUpdate(null, { gross_margin_rate: 0.5 })).toMatchObject({
      ok: false,
      error_code: 'aov_required',
    })
    expect(prepareEconomicsInputsUpdate(null, { aov: 220 })).toMatchObject({
      ok: false,
      error_code: 'source_note_required',
    })
    expect(prepareEconomicsInputsUpdate(null, { aov: 220, source_note: 'Owner estimate from current price mix' })).toEqual({
      ok: true,
      inputs: {
        aov: 220,
        gross_margin_rate: null,
        repeat_rate: null,
        source_note: 'Owner estimate from current price mix',
      },
    })
  })

  it('the economics API exposes read provenance and historical audit context without current authority', async () => {
    state.setting = {
      data: {
        value: JSON.stringify({ aov: 220, gross_margin_rate: 0.55, repeat_rate: null, source_note: 'Manual estimate' }),
        updated_at: '2026-07-30T12:00:00Z',
      },
      error: null,
    }
    const { GET } = await import('@/app/api/economics/route')

    const response = await GET()
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.economics_inputs).toMatchObject({
      status: 'available',
      inputs: { aov: 220 },
      provenance: { status: 'unversioned_app_setting', owner_approval_recorded: false, version_recorded: false },
    })
    expect(body.champion).toMatchObject({
      context_status: 'historical_audit_only', action_authority: 'none', current_policy: false,
    })
    expect(body.proposed_cpa_bands).toMatchObject({ status: 'proposal_only', action_authority: 'none' })
  })

  it('the economics API rejects a first AOV write without an explicit source note', async () => {
    const { PUT } = await import('@/app/api/economics/route')
    const response = await PUT(new Request('http://localhost/api/economics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aov: 220 }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'source_note_required' })
  })
})

describe('general settings cannot mint policy, economics, or tracking defaults', () => {
  beforeEach(() => {
    state.activeResolution = { ok: true, account: { id: 'account-1', accountName: 'Example Studio' } }
    state.adminCalls = 0
  })

  it('blocks the legacy POST initializer before any database write', async () => {
    const { POST } = await import('@/app/api/settings/route')
    const response = await POST(new Request('http://localhost/api/settings', { method: 'POST' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'DEFAULT_SETTINGS_INITIALIZATION_DISABLED',
    })
    expect(state.adminCalls).toBe(0)
  })

  it.each([
    'target_cpa',
    'avg_order_value',
    'main_conversion_event',
    'pixel_id',
    'read_only_mode',
    'weekly_auto_sync',
    'brand_tone',
    'instagram_handle',
    'competitor_tracking_enabled',
    'expert_tracker_enabled',
    'approved_write_mode',
    'performance_targets',
    'economics_inputs',
    'appointment_conversion_id',
  ])('blocks ungoverned PATCH writes to %s before database access', async (key) => {
    const { PATCH } = await import('@/app/api/settings/route')
    const response = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value: 'arbitrary' }),
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNGOVERNED_SETTING_KEY', key })
    expect(state.adminCalls).toBe(0)
  })

  it('quarantines legacy high-risk settings from the editable general-settings feed', async () => {
    const { partitionSettingsForGeneralEditor } = await import('@/app/api/settings/route')
    const out = partitionSettingsForGeneralEditor([
      { key: 'target_cpa', value: '60' },
      { key: 'pixel_id', value: '100000000000179' },
      { key: 'brand_tone', value: 'premium' },
    ])

    expect(out.settings).toEqual([])
    expect(out.quarantined_settings).toEqual([
      { key: 'target_cpa', reason_code: 'governed_elsewhere_or_unversioned' },
      { key: 'pixel_id', reason_code: 'governed_elsewhere_or_unversioned' },
      { key: 'brand_tone', reason_code: 'governed_elsewhere_or_unversioned' },
    ])
  })

  it.each([
    ['not_found', 404, 'ACTIVE_ACCOUNT_NOT_FOUND'],
    ['ambiguous', 409, 'ACTIVE_ACCOUNT_AMBIGUOUS'],
    ['unavailable', 503, 'ACTIVE_ACCOUNT_UNAVAILABLE'],
  ] as const)('fails closed when active-account ownership is %s', async (reason, status, code) => {
    state.activeResolution = { ok: false, reason }
    const { GET } = await import('@/app/api/settings/route')

    const response = await GET()
    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({ code })
  })

  it('contains no initializer copy or hard-coded commercial/tracking seed values', () => {
    const page = read('src/app/(dashboard)/settings/page.tsx')
    const route = read('src/app/api/settings/route.ts')
    const economics = read('src/lib/economics/settings.ts')

    expect(page).not.toContain('Initialize Defaults')
    expect(page).not.toMatch(/target CPA \$\d/i)
    expect(page).not.toMatch(/AOV \$\d/)
    expect(route).not.toMatch(/target_cpa['"],\s*value:\s*['"]\d/)
    expect(route).not.toMatch(/avg_order_value['"],\s*value:\s*['"]\d/)
    expect(route).not.toContain("value: '100000000000179'")
    expect(economics).not.toContain('DEFAULT_ECONOMICS_INPUTS')
    expect(economics).toContain('resolveOnlyActiveAccount')
    expect(economics).not.toContain('META_AD_ACCOUNT_ID')
  })

  it('describes the historical champion as audit context, never current policy or a scaling bar', () => {
    const toolIndex = read('src/mcp/tools/tool-definitions-secondary.ts')
    const definition = toolIndex.slice(toolIndex.indexOf("name: 'get_economics'"), toolIndex.indexOf("name: 'get_playbook'"))

    expect(definition).toMatch(/historical audit/i)
    expect(definition).toMatch(/no action authority/i)
    expect(definition).not.toMatch(/owner.?s scaling bar/i)
  })
})
