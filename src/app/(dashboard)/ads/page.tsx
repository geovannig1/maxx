import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'
import { buildPreservedPerformanceRedirect } from '@/lib/performance/presets'

// Re-parented into the Performance destination. Preserves the ?adset= drilldown so an ad-set→ad drill
// (or a bookmark) lands on the right scoped view.
export default async function AdsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner()

  redirect(buildPreservedPerformanceRedirect('/performance/ads', await searchParams))
}
