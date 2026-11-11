import { LowDataNotice } from '@/components/ui/LowDataNotice'

/**
 * Honest replacement for the legacy independent reallocation brain. Money
 * direction returns only after it is derived from the governed CampaignPlan.
 */
export function ActionPlan() {
  return (
    <LowDataNotice
      title="Automated budget moves are intentionally unavailable"
      message="Maxx can describe delivery, but it will not convert Meta-modelled results into budget moves. Budget direction remains blocked until a committed campaign plan, owner-governed targets, and complete paid-interaction outcome cohorts exist."
      items={[
        { label: 'Current authority', have: 'Diagnostic only', need: 'Governed CampaignPlan decision' },
        { label: 'Outcome evidence', have: 'Meta-modelled delivery', need: 'Complete paid-interaction cohort' },
      ]}
    />
  )
}
