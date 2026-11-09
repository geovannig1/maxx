import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'
import { buildPreservedPerformanceRedirect } from '@/lib/performance/presets'

// Promoted OUT of Performance into its own destination (`/creative`), per the 7-destination target
// IA ratified 2026-08-28. Kept as a redirect so bookmarks + links never 404 — the same treatment the
// other 16 re-parented routes in this tree already get. Range/preset context is preserved, so a
// bookmarked `?range=mtd` still lands on the window it always did.
export default async function PerformanceCreativeRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner()

  redirect(buildPreservedPerformanceRedirect('/creative', await searchParams))
}
