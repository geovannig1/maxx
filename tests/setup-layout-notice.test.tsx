import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// when configuration is incomplete the dashboard shows the setup checklist link and what is
// missing (names only) instead of a broken page. Demo mode never shows it.

const auth = vi.hoisted(() => ({ user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }) }))
// The chrome polls account-scoped APIs (alerts, changes, approvals); the layout says whether an ad
// account exists to poll for, so an unconfigured install makes no request that can only fail.
const chrome = vi.hoisted(() => ({ props: [] as Array<{ name: string; accountReady?: boolean }>, active: { ok: true } as { ok: boolean } }))
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: (props: { accountReady?: boolean }) => { chrome.props.push({ name: 'Sidebar', ...props }); return null } }))
vi.mock('@/components/layout/Topbar', () => ({ Topbar: (props: { accountReady?: boolean }) => { chrome.props.push({ name: 'Topbar', ...props }); return null } }))
vi.mock('@/lib/accounts/active-account', () => ({ resolveOnlyActiveAccount: async () => chrome.active }))
vi.mock('@/components/layout/MobileNavContext', () => ({ MobileNavProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/targets/TargetRangesProvider', () => ({ TargetRangesProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/maxx/MaxxLauncher', () => ({ MaxxLauncher: () => null }))
vi.mock('@/lib/maxx/chat', () => ({ maxxChatEnabled: () => false }))

import DashboardLayout from '@/app/(dashboard)/layout'

const COMPLETE = {
  OWNER_EMAIL: 'owner@example.test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture-0123456789',
  META_ACCESS_TOKEN: 'meta-credential-fixture-value',
  META_AD_ACCOUNT_ID: 'act_123',
}
const render = async () => renderToStaticMarkup(await DashboardLayout({ children: <p>DASHBOARD-CONTENT</p> }))

beforeEach(() => {
  for (const [k, v] of Object.entries(COMPLETE)) vi.stubEnv(k, v)
  chrome.props = []
  chrome.active = { ok: true }
})
afterEach(() => vi.unstubAllEnvs())

describe('dashboard layout setup notice', () => {
  it('shows the notice with the missing variable names, not the page, when Meta is not configured', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    const html = await render()
    expect(html).not.toContain('DASHBOARD-CONTENT')
    expect(html).toContain('META_ACCESS_TOKEN')
    expect(html).toContain('href="/setup"')
    expect(html).not.toContain('meta-credential-fixture-value')
    // Outcome pages are under this layout too: say why they also wait for Meta.
    expect(html).toContain('Outcome sources and CSV import belong to that ad account')
  })

  it('control: a missing database key is not explained as a Meta dependency', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const html = await render()
    expect(html).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(html).not.toContain('Outcome sources and CSV import')
  })

  it('control: a complete configuration renders the page', async () => {
    const html = await render()
    expect(html).toContain('DASHBOARD-CONTENT')
    expect(html).not.toContain('data-setup-required')
  })

  it('demo mode renders the page with a sample-data banner', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    vi.stubEnv('MAXX_DEMO', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const html = await render()
    expect(html).toContain('DASHBOARD-CONTENT')
    expect(html).toContain('Sample data')
  })

  it('tells the chrome there is no account to poll while setup is incomplete or before the first sync', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    await render()
    expect(chrome.props).toEqual([{ name: 'Sidebar', accountReady: false }, { name: 'Topbar', accountReady: false }])
    vi.stubEnv('META_ACCESS_TOKEN', COMPLETE.META_ACCESS_TOKEN)
    chrome.props = []
    chrome.active = { ok: false }
    await render()
    expect(chrome.props.every((p) => p.accountReady === false)).toBe(true)
  })

  it('control: a configured install with its ad account polls as before', async () => {
    await render()
    expect(chrome.props).toEqual([{ name: 'Sidebar', accountReady: true }, { name: 'Topbar', accountReady: true }])
  })
})
