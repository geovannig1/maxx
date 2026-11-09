import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'
import { buildPreservedPerformanceRedirect } from '@/lib/performance/presets'

// Re-parented into the Performance destination. Preserves the ?campaign= drilldown so a campaign→ad-set
// drill (or a bookmark) lands on the right scoped view.
export default async function AdsetsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner()

  redirect(buildPreservedPerformanceRedirect('/performance/adsets', await searchParams))
}
