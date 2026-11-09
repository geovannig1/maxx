import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The dashboard layout is the second owner gate behind src/proxy.ts. Every dashboard page renders
// with the service-role client, so the layout itself must refuse a missing session and a signed-in
// non-owner, and must let the configured owner through.
const auth = vi.hoisted(() => ({ user: null as null | { email: string; email_confirmed_at?: string } }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`) },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
}))
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/components/layout/Topbar', () => ({ Topbar: () => null }))
vi.mock('@/components/layout/MobileNavContext', () => ({ MobileNavProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/targets/TargetRangesProvider', () => ({ TargetRangesProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/maxx/MaxxLauncher', () => ({ MaxxLauncher: () => null }))
vi.mock('@/lib/maxx/chat', () => ({ maxxChatEnabled: () => false }))

import DashboardLayout from '@/app/(dashboard)/layout'

describe('dashboard layout owner gate', () => {
  const previousOwner = process.env.OWNER_EMAIL
  beforeEach(() => { process.env.OWNER_EMAIL = 'owner@example.test' })
  afterEach(() => { process.env.OWNER_EMAIL = previousOwner; auth.user = null })

  it('redirects to /login when there is no session', async () => {
    auth.user = null
    await expect(DashboardLayout({ children: null })).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects a signed-in non-owner', async () => {
    auth.user = { email: 'intruder@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    await expect(DashboardLayout({ children: null })).rejects.toThrow('REDIRECT:/login?error=unauthorized')
  })

  it('renders for the configured owner, case-insensitively', async () => {
    auth.user = { email: 'Owner@Example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    const tree = await DashboardLayout({ children: null })
    expect(tree).toBeTruthy()
  })
})
