import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { freshSchemaDb } from './db/schema-db'

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8')
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}

function expectEveryReadScoped(file: string, table: string): void {
  const source = read(file)
  const fromCount = countMatches(source, new RegExp(`\\.from\\('${table}'\\)`, 'g'))
  const scopedCount = countMatches(
    source,
    new RegExp(`\\.from\\('${table}'\\)(?:(?!\\.from\\().){0,900}?\\.eq\\('ad_account_id',`, 'gs'),
  )
  expect(fromCount, `${file} should read ${table}`).toBeGreaterThan(0)
  expect(scopedCount, `${file}: every ${table} read must carry ad_account_id`).toBe(fromCount)
}

describe('owner/model surfaces are account-scoped', () => {
  it('pins account-bearing schema evidence before requiring filters', async () => {
    const tables = [
      'daily_reports', 'weekly_reports', 'daily_insights', 'alerts', 'audit_tasks', 'flags',
      'change_requests', 'daypart_insights', 'api_sync_logs',
      'recommendation_outcomes', 'adsets', 'campaigns', 'ads', 'learned_patterns',
      'expert_insights', 'recommendation_decisions', 'ad_setup_decisions',
    ]
    const db = await freshSchemaDb()
    try {
      // Read from the shipped schema's catalog. The control, ad_accounts, is a real table that carries no
      // ad_account_id column, so the same query must leave it out.
      const { rows } = await db.query<{ table_name: string }>(`
        SELECT c.relname AS table_name FROM unnest($1::text[]) t(name)
          JOIN pg_class c ON c.relname = t.name AND c.relkind = 'r'
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'ad_account_id' AND NOT a.attisdropped
         ORDER BY 1`, [[...tables, 'ad_accounts']])
      expect(rows.map((row) => row.table_name), 'account-bearing tables').toEqual([...tables].sort())
    } finally {
      await db.close()
    }
  })

  it('scopes every account-bearing dashboard read to the resolved active account', () => {
    const file = 'src/components/dashboard/dashboard-data.ts'
    for (const table of [
      'daypart_insights', 'daily_reports', 'daily_insights', 'alerts', 'audit_tasks', 'flags',
      'change_requests', 'api_sync_logs', 'recommendation_outcomes',
      'adsets', 'campaigns', 'ads',
    ]) expectEveryReadScoped(file, table)

    const source = read(file)
    expect(source).toMatch(/activeAccountId \? await anyActiveAdsetExitedLearning\(activeAccountId\) : false/)
    expect(source).toMatch(/acctId \? await computeUtmCoverage\(acctId\) : null/)
  })

  it('scopes active recommendation and change-history reads', () => {
    const expectations: Array<[string, string[]]> = [
      ['src/app/report/client/page.tsx', ['daily_insights', 'campaigns']],
      ['src/lib/decisions/read-model.ts', ['alerts', 'audit_tasks', 'recommendation_outcomes', 'recommendations']],
      ['src/app/(dashboard)/activity/change-log/page.tsx', ['change_requests']],
      ['src/mcp/tools/decision-history.ts', ['recommendation_decisions']],
      ['src/mcp/tools/learnings.ts', ['recommendation_outcomes']],
      ['src/mcp/tools/operating-mode.ts', ['daily_insights']],
      ['src/lib/modes/structural-continuity.ts', ['daily_insights', 'ads', 'adsets', 'campaigns', 'change_requests', 'ad_setup_decisions']],
      ['src/mcp/tools/account-summary.ts', ['daily_insights', 'campaigns', 'alerts']],
      ['src/mcp/tools/action-log.ts', ['action_log']],
      ['src/mcp/tools/campaign-performance.ts', ['campaigns', 'daily_insights']],
      ['src/mcp/tools/copy-bank.ts', ['copy_variations']],
      ['src/lib/creative/copy-studio.ts', ['creatives']],
      ['src/mcp/tools/daily-report.ts', ['daily_reports', 'audit_tasks']],
      ['src/mcp/tools/alerts-tasks.ts', ['alerts', 'audit_tasks']],
      ['src/mcp/tools/flags.ts', ['flags']],
      ['src/app/api/adsets/route.ts', ['adsets', 'campaigns', 'daily_insights']],
      ['src/app/api/campaigns/route.ts', ['campaigns', 'daily_insights']],
      ['src/app/api/flags/route.ts', ['flags']],
      ['src/app/api/alerts/route.ts', ['alerts']],
      ['src/app/(dashboard)/maxx/page.tsx', ['flags', 'audit_tasks', 'daily_reports']],
    ]
    for (const [file, tables] of expectations) {
      for (const table of tables) expectEveryReadScoped(file, table)
    }
    expect(read('src/mcp/tools/learnings.ts')).not.toContain(".from('learned_patterns')")
    // The Copy studio's bank READ is scoped; its one write (insert) carries ad_account_id in every row.
    const copyStudio = read('src/lib/creative/copy-studio.ts')
    expect(copyStudio).toMatch(/\.from\('copy_variations'\)\s*\.select\([^)]*\)\s*\.eq\('ad_account_id', accountId\)/)
    expect(copyStudio).toMatch(/ad_account_id: account\.account\.id, copy_type: field/)
    expect(countMatches(copyStudio, /\.from\('copy_variations'\)/g)).toBe(2)
  })

  it('scopes task reads and writes, and binds PATCH mutations to the active account', () => {
    const tasks = read('src/app/api/tasks/route.ts')
    expect(tasks).toMatch(/from\('audit_tasks'\)[\s\S]{0,400}?\.eq\('ad_account_id', activeAccount\.account\.id\)/)
    expect(tasks).toMatch(/code: 'ACTION_DECISION_REQUIRED'/)
    expect(tasks).not.toMatch(/\.from\('audit_tasks'\)\.insert\(/)

    const taskPatch = read('src/app/api/tasks/[id]/route.ts')
    expect(taskPatch).toMatch(/resolveOnlyActiveAccount\(adminClient\)/)
    expect(countMatches(taskPatch, /\.eq\('ad_account_id', activeAccount\.account\.id\)/g)).toBe(2)
    expect(taskPatch).toMatch(/projectCurrentActionableTasks/)

    const patch = read('src/app/api/setup-decisions/[id]/route.ts')
    expect(patch).toMatch(/row\.origin === 'launch_setup'[\s\S]{0,500}?resolveOnlyActiveAccount\(admin\)/)
    expect(patch).toMatch(/row\.ad_account_id !== activeAccount\.account\.id/)
    expect(countMatches(patch, /\.update\([\s\S]{0,350}?\.eq\('ad_account_id', adAccountId\)/g)).toBe(2)
  })

  it('renders explicit account-resolution failures instead of healthy empty owner pages', () => {
    const notice = read('src/components/accounts/ActiveAccountUnavailableNotice.tsx')
    expect(notice).toMatch(/data-active-account-error=/)
    expect(notice).toMatch(/Maxx will not combine them or choose one silently/)

    for (const file of ['src/app/(dashboard)/activity/change-log/page.tsx']) {
      const source = read(file)
      expect(source, file).toMatch(/ActiveAccountUnavailableNotice/)
      expect(source, file).toMatch(/activeAccountErrorCode\(/)
    }
  })

  it('keeps legacy approvals out of actionable dashboard and inbox counts', () => {
    const dashboard = read('src/components/dashboard/dashboard-data.ts')
    const inbox = read('src/app/(dashboard)/inbox/page.tsx')
    const page = read('src/app/(dashboard)/dashboard/page.tsx')

    expect(dashboard).not.toMatch(/from\('pending_approvals'\)/)
    expect(dashboard).not.toMatch(/pendingCount/)
    expect(inbox).not.toMatch(/from\('pending_approvals'\)/)
    expect(inbox).not.toMatch(/counts\.pendingApprovals/)
    expect(page).not.toMatch(/pendingCount/)
    expect(page).not.toMatch(/pendingApprovals/)
  })
})
