import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FileText } from 'lucide-react'
import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { isDemoMode } from '@/config/demo'
import { getAdPlatform } from '@/lib/platforms/registry'
import { getPlan } from '@/lib/campaigns/plan-repository'
import { loadPlanContext } from '@/lib/campaigns/plan-context'
import { PLAN_STATUS_LABEL } from '@/lib/campaigns/plan-spec'
import { PageHeader } from '@/components/layout/PageHeader'
import { PlanEditor } from '@/components/campaigns/PlanEditor'
import { PlanReadinessList } from '@/components/campaigns/PlanChecklist'

// ADR-062: one campaign plan: its latest version (editable while it is a draft), validation inline,
// the launch-readiness checklist, its approval request and the objects created in Meta.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function CampaignPlanPage({ params }: { params: Promise<{ planId: string }> }) {
  await requireOwner()
  const { planId } = await params
  if (!UUID.test(planId)) notFound()
  const result = await getPlan(planId)
  if (!result.ok) {
    if (result.http === 404) notFound()
    return <p role="alert" className="text-[13px]" style={{ color: 'var(--danger)' }}>This plan could not be read ({result.code}).</p>
  }
  const { plan, versions, changeRequests, objects } = result.detail
  const version = versions[0]
  if (!version) notFound()
  // Audience options for the editor; a failed read leaves the selects empty, never guesses.
  const db = getAdminClient()
  const account = await resolveOnlyActiveAccount(db)
  const context = account.ok ? await loadPlanContext(db, account.account.id).catch(() => null) : null
  const audiences = context?.ok ? context.context.draft.audiences.map((a) => ({ id: a.id, name: a.name, approximateCount: a.approximateCount })) : []
  const minorPerMajor = getAdPlatform('meta').budgetUnits.toMinor(1, version.currency)
  const writeMode = isDemoMode() ? 'demo' as const : process.env.WRITE_MODE_ENABLED === 'true' ? 'on' as const : 'off' as const
  const request = changeRequests.find((r) => r.campaign_plan_version_id === version.id && !r.rollback_of)
  const created = objects.filter((o) => o.plan_version_id === version.id && o.meta_id)
  return (
    <div className="owner-page space-y-4 max-w-3xl" data-campaign-plan={plan.id} data-plan-status={version.status}>
      <div className="owner-surface owner-surface-section">
        <PageHeader title={plan.title} icon={FileText}
          subtitle={`Version ${version.version} · ${PLAN_STATUS_LABEL[version.status]} · drafted by ${version.source === 'ai' ? 'AI, normalised by Maxx' : version.source === 'template' ? 'Maxx’s template planner' : 'you'}`} />
      </div>
      {version.notes.length > 0 && (
        <ul className="card-base p-4 space-y-1 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          {version.notes.map((note, i) => <li key={i}>{note}</li>)}
        </ul>
      )}
      {request && (
        <p className="card-base p-4 text-[12.5px]" data-plan-request={request.status} style={{ color: 'var(--text-secondary)' }}>
          Approval request: <b>{request.status}</b>{request.result && typeof request.result.message === 'string' ? `. ${request.result.message}` : ''}{' '}
          <Link href="/changes" style={{ color: 'var(--accent)' }}>Open Changes</Link>
        </p>
      )}
      {created.length > 0 && (
        <section className="card-base p-4 text-[12.5px]" data-plan-objects style={{ color: 'var(--text-secondary)' }}>
          <h2 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Created in Meta (paused){created.some((o) => o.simulated) ? ' · Demo: simulated' : ''}</h2>
          <ul>{created.map((o) => <li key={o.local_key}>{o.object_kind} {o.meta_id} · {o.state}</li>)}</ul>
        </section>
      )}
      <PlanReadinessList items={version.readiness} />
      <PlanEditor planId={plan.id} versionId={version.id} status={version.status} spec={version.spec} issues={version.validation}
        audiences={audiences} minorPerMajor={minorPerMajor} writeMode={writeMode} />
    </div>
  )
}
