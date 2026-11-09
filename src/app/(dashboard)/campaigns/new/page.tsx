import Link from 'next/link'
import { Rocket } from 'lucide-react'
import { requireOwner } from '@/lib/auth/page-owner'
import { aiStatus } from '@/lib/ai'
import { firstPlannableDate } from '@/lib/campaigns/plan-dates'
import { PageHeader } from '@/components/layout/PageHeader'
import { PlanBriefForm } from '@/components/campaigns/PlanBriefForm'

// ADR-062: Campaigns → New campaign. A brief becomes a complete, validated campaign plan draft.
export default async function NewCampaignPage() {
  await requireOwner()
  const today = firstPlannableDate()
  return (
    <div className="owner-page space-y-4 max-w-3xl" data-campaign-new>
      <div className="owner-surface owner-surface-section">
        <PageHeader title="New campaign" icon={Rocket}
          subtitle="Describe the campaign. Maxx drafts the structure, audiences, budget and copy; you review it, submit it, and approve it on Changes. Everything is created paused." />
      </div>
      <PlanBriefForm aiOn={aiStatus().state === 'on'} today={today} />
      <p className="text-[12.5px]"><Link href="/campaigns/plans" style={{ color: 'var(--accent)' }}>See all campaign plans</Link></p>
    </div>
  )
}
