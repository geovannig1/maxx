import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pages now call requireOwner() themselves (src/lib/auth/page-owner.ts); this test measures the
// account boundary, not auth, so the owner check is satisfied up front.
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => ({ email: 'owner@example.test' }) }))
const state = vi.hoisted(() => ({
  reason: 'ambiguous' as 'not_found' | 'ambiguous' | 'unavailable',
  tableReads: [] as string[],
}))

vi.mock('@/lib/accounts/active-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts/active-account')>()
  return {
    ...actual,
    resolveOnlyActiveAccount: vi.fn(async () => ({ ok: false, reason: state.reason })),
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.tableReads.push(table)
      throw new Error(`Unexpected account-bearing read: ${table}`)
    },
  }),
}))

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('owner report and change pages fail closed at the active-account boundary', () => {
  beforeEach(() => {
    state.reason = 'ambiguous'
    state.tableReads = []
  })

  it('scopes the dated report, its lineage, and its tasks to the resolved account', () => {
    const source = read('src/app/(dashboard)/reports/[date]/page.tsx')

    expect(source).toMatch(/resolveOnlyActiveAccount\(db\)/)
    expect(source).toMatch(/ActiveAccountUnavailableNotice/)
    expect(source).toMatch(/from\('daily_reports'\)[\s\S]{0,650}?\.eq\('ad_account_id', accountId\)/)
    expect(source).toMatch(/getRecLineageStatus\(db, accountId,/)
    expect(source).toMatch(/from\('audit_tasks'\)[\s\S]{0,650}?\.eq\('ad_account_id', accountId\)/)
  })

  it('scopes pending changes to the resolved account and surfaces resolution failure', () => {
    const source = read('src/app/(dashboard)/changes/page.tsx')

    expect(source).toMatch(/resolveOnlyActiveAccount\(db\)/)
    expect(source).toMatch(/ActiveAccountUnavailableNotice/)
    expect(source).toMatch(/from\('change_requests'\)[\s\S]{0,650}?\.eq\('ad_account_id', accountId\)/)
  })

  it.each([
    { reason: 'not_found' as const, code: 'ACTIVE_ACCOUNT_NOT_FOUND' },
    { reason: 'ambiguous' as const, code: 'ACTIVE_ACCOUNT_AMBIGUOUS' },
    { reason: 'unavailable' as const, code: 'ACTIVE_ACCOUNT_UNAVAILABLE' },
  ])('renders $code without downstream reads', async ({ reason, code }) => {
    state.reason = reason
    const [{ default: ReportPage }, { default: ChangesPage }] = await Promise.all([
      import('@/app/(dashboard)/reports/[date]/page'),
      import('@/app/(dashboard)/changes/page'),
    ])

    const [report, changes] = await Promise.all([
      ReportPage({ params: Promise.resolve({ date: '2026-07-29' }) }),
      ChangesPage(),
    ])
    const html = [report, changes].map((node) => renderToStaticMarkup(node)).join('\n')

    expect(html.match(new RegExp(`data-active-account-error="${code}"`, 'g'))).toHaveLength(2)
    expect(state.tableReads).toEqual([])
  })
})
