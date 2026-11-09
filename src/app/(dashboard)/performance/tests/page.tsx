import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'
import { buildPreservedPerformanceRedirect } from '@/lib/performance/presets'

// Promoted OUT of Performance into its own destination (`/experiments`), completing the
// 7-destination target IA ratified 2026-08-28. Kept as a redirect so bookmarks + links never 404 —
// the same treatment every other re-parented route in this tree gets.
export default async function PerformanceTestsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner()

  redirect(buildPreservedPerformanceRedirect('/experiments', await searchParams))
}
