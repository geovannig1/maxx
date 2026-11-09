import Link from 'next/link'
import { FileText, Plus } from 'lucide-react'
import { requireOwner } from '@/lib/auth/page-owner'
import { listPlans } from '@/lib/campaigns/plan-repository'
import { PLAN_STATUS_LABEL } from '@/lib/campaigns/plan-spec'
import { accountTimezone } from '@/config/business-config'
import { PageHeader } from '@/components/layout/PageHeader'

// ADR-062: every campaign plan of the active account with its latest status.
const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--text-secondary)', pending_approval: 'var(--warning)', approved: 'var(--accent)', creating: 'var(--accent)',
  created_paused: 'var(--success)', failed: 'var(--danger)', rejected: 'var(--text-tertiary)', archived: 'var(--text-tertiary)', superseded: 'var(--text-tertiary)',
}

export default async function CampaignPlansPage() {
  await requireOwner()
  const result = await listPlans()
  return (
    <div className="owner-page space-y-4 max-w-3xl" data-campaign-plans>
      <div className="owner-surface owner-surface-section">
        <PageHeader title="Campaign plans" icon={FileText} subtitle="Drafted, waiting for approval, created paused, or failed with what to do next."
          controls={<Link href="/campaigns/new" className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold" style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--accent)' }}><Plus size={14} aria-hidden /> New campaign</Link>} />
      </div>
      {!result.ok && <p role="alert" className="text-[13px]" style={{ color: 'var(--danger)' }}>Campaign plans could not be read ({result.code}).</p>}
      {result.ok && result.rows.length === 0 && <p className="card-base p-4 text-[13px]" style={{ color: 'var(--text-secondary)' }}>No plans yet. Start with New campaign, or ask Maxx to draft one.</p>}
      {result.ok && result.rows.length > 0 && (
        <ul className="space-y-2">
          {result.rows.map((plan) => (
            <li key={plan.id} className="card-base p-4" data-plan-row={plan.id} data-plan-status={plan.status ?? 'unknown'}>
              <Link href={`/campaigns/plans/${plan.id}`} className="flex items-center justify-between gap-3 flex-wrap" style={{ minHeight: 44 }}>
                <span>
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{plan.title}</span>
                  <span className="block text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    Version {plan.latest_version}{plan.total_daily_budget ? ` · ${plan.total_daily_budget}/day` : ''} · created {new Date(plan.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: accountTimezone() })}
                  </span>
                </span>
                <span className="text-[11px] font-bold uppercase rounded-md px-2 py-0.5" style={{ color: STATUS_COLOR[plan.status ?? ''] ?? 'var(--text-tertiary)', border: '1px solid currentColor' }}>
                  {plan.status ? PLAN_STATUS_LABEL[plan.status] : 'Unknown'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
