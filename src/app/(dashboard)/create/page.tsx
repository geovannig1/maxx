import { requireOwner } from '@/lib/auth/page-owner'
import { ImagePlus } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'
import { CAMPAIGN_PLAN_CREATIVE_BLOCKER } from '@/lib/creative/campaign-plan-gate'

export default async function CreatePage() {
  await requireOwner()

  return (
    <div className="owner-page owner-page-narrow">
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Governed creative is blocked"
          icon={ImagePlus}
          subtitle="Image and video generation is not connected yet. Write and score ad copy in the Copy studio; campaign plans use creatives already in your ad account."
        />
      </div>

      <div className="owner-surface">
        <EmptyState
          icon={ImagePlus}
          title="Image and video generation is unavailable"
          description={`Governed blocked status: ${CAMPAIGN_PLAN_CREATIVE_BLOCKER}`}
          tone="info"
        />
      </div>
    </div>
  )
}
