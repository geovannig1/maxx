import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

/** Compatibility route. Recommendation rows remain in their original durable stores; only their
 * owner-facing projection moved into Decisions. Preserve incoming query values for old bookmarks. */
export default async function RecommendationsCompatibilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireOwner()

  const incoming = await searchParams
  const params = new URLSearchParams({ view: 'needs_review', legacy: 'recommendations' })
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'view' || key === 'legacy' || value === undefined) continue
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item))
    else params.set(key, value)
  }
  redirect(`/decisions?${params.toString()}`)
}
