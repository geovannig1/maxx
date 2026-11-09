import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'
import { buildPreservedPerformanceRedirect } from '@/lib/performance/presets'

// Re-parented into the Performance destination. Kept as a redirect so bookmarks + nav links + Maxx
// MCP references never 404. The nav itself points straight at /performance.
export default async function CampaignsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner()

  redirect(buildPreservedPerformanceRedirect('/performance/campaigns', await searchParams))
}
