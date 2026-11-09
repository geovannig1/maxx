import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'
import { buildPreservedPerformanceRedirect } from '@/lib/performance/presets'

// Re-parented into the Performance destination. Kept as a redirect so bookmarks + links never 404.
export default async function TestsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner()

  redirect(buildPreservedPerformanceRedirect('/performance/tests', await searchParams))
}
