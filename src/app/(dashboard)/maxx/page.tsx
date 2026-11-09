export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { Bot, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { MaxxChat } from '@/components/maxx/MaxxChat'
import Link from 'next/link'
import { projectCurrentActionableTasks, projectStoredReport } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount, type ActiveAccountErrorCode } from '@/lib/accounts/active-account'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { maxxChatEnabled } from '@/lib/maxx/chat'
import { aiStatus } from '@/lib/ai'
import { MaxxEvidenceNotice } from '@/components/maxx/MaxxEvidenceNotice'
import { StatePanel } from '@/components/ui/state-panel'

async function getLatestContext() {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) return {
    flags: [],
    tasks: [],
    lastReport: null,
    accountErrorCode: activeAccountErrorCode(activeAccount.reason),
  }
  const accountId = activeAccount.account.id
  const [flags, tasks, report] = await Promise.all([
    db.from('flags').select('flag_type, reason').eq('ad_account_id', accountId).eq('is_active', true).order('flag_date', { ascending: false }).limit(5),
    db.from('audit_tasks').select('id, title, recommendation, priority, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)').eq('ad_account_id', accountId).in('status', ['open', 'in_progress']).order('created_at', { ascending: false }).limit(100),
    db.from('daily_reports').select('report_date, summary_text, full_report_md, report_json, money_basis_version').eq('ad_account_id', accountId).order('report_date', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (flags.error || tasks.error || report.error) return {
    flags: [],
    tasks: [],
    lastReport: null,
    accountErrorCode: 'ACTIVE_ACCOUNT_UNAVAILABLE' as ActiveAccountErrorCode,
  }
  return {
    flags: flags.data ?? [],
    tasks: projectCurrentActionableTasks((tasks.data ?? []) as Array<Record<string, unknown>>).slice(0, 5),
    lastReport: report.data ? projectStoredReport(report.data as Record<string, unknown>) : null,
    accountErrorCode: null,
  }
}

const FLAG_TONE: Record<string, string> = {
  winner: 'var(--success)',
  loser: 'var(--danger)',
  scale_candidate: 'var(--accent)',
  watchlist: 'var(--warning)',
  creative_refresh: 'var(--warning)',
}

export default async function MaxxPage() {
  await requireOwner()

  const { flags, tasks, lastReport, accountErrorCode } = await getLatestContext()
  const chatEnabled = maxxChatEnabled()
  const ai = aiStatus()

  return (
    <div className="space-y-5">
      <PageHeader
        title="Maxx"
        icon={Bot}
        subtitle="Ask your media buyer anything about the account — grounded in live Meta + GA4 data. It drafts; only you approve."
      />

      {accountErrorCode && <ActiveAccountUnavailableNotice code={accountErrorCode} />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5 items-start">
        {/* The chat — or, when it's turned off, an honest note on the free way to reach Maxx. */}
        {chatEnabled ? (
          <div className="card-base p-4" style={{ height: 'min(72vh, 680px)' }}>
            <MaxxChat />
          </div>
        ) : (
          <div className="card-base p-6">
            <MaxxEvidenceNotice />
            <div className="mt-4 rounded-xl" style={{ border: '1px solid var(--border)' }}>
              <StatePanel
                state="blocked"
                compact
                title={ai.state === 'on' ? 'In-app chat is off' : 'AI is off'}
                description={ai.state === 'off'
                  ? 'No AI provider is configured (AI_PROVIDER=none or unset), so the chat is unavailable. Every report, diagnostic and data page works without AI. Set AI_PROVIDER to turn AI features on.'
                  : ai.state === 'misconfigured'
                    ? 'An AI provider is set but its configuration is invalid, so AI features are off. Run npm run doctor to see which variable to fix. Every other page works without AI.'
                    : 'Browser chat is temporarily disabled while evidence coverage and action output move to the governed numeric-answer contract. Diagnostics remain available and read-only.'}
              />
            </div>
          </div>
        )}

        {/* Live-context rail — what Maxx is looking at right now, so the chat isn't a black box. */}
        <div className="space-y-4">
          <div className="card-base p-4">
            <p className="section-label mb-2.5">What Maxx sees right now</p>
            {accountErrorCode ? (
              <p style={{ fontSize: 12.5, color: 'var(--warning)' }}>Live account context is unavailable; Maxx is not treating this as an empty account.</p>
            ) : flags.length === 0 ? (
              <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No active flags — nothing needs attention on the ads yet.</p>
            ) : (
              <div className="space-y-2">
                {flags.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, marginTop: 6, flexShrink: 0, background: FLAG_TONE[f.flag_type as string] ?? 'var(--text-disabled)' }} />
                    <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }} className="line-clamp-2">{f.reason as string}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {tasks.length > 0 && (
            <div className="card-base p-4">
              <p className="section-label mb-2.5">Open tasks</p>
              <div className="space-y-1.5">
                {tasks.map((t, i) => (
                  <p key={i} style={{ fontSize: 12.5, color: 'var(--text-secondary)' }} className="line-clamp-1">
                    {t.title as string}
                  </p>
                ))}
              </div>
              <Link href="/inbox" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', marginTop: 8, display: 'inline-block' }}>Open Inbox →</Link>
            </div>
          )}

          {typeof lastReport?.summary_text === 'string' && lastReport.summary_text.length > 0 && (
            <div className="card-base p-4">
              <p className="section-label mb-2">Latest report</p>
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }} className="line-clamp-4">{lastReport.summary_text as string}</p>
              <Link href={`/reports/${lastReport.report_date as string}`} style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', marginTop: 8, display: 'inline-block' }}>Read {lastReport.report_date as string} →</Link>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, padding: '11px 13px', borderRadius: 10, background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
            <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: 'var(--success)', marginTop: 1 }} />
            <p style={{ fontSize: 11.5, color: 'var(--success)', lineHeight: 1.45 }}>
              Maxx reads your account and advises. It can draft copy, campaign plans and change proposals; only you approve them, on the Changes page. An approved change applies only with write mode on, and new campaigns are created paused.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
