import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

// Alerts are a filtered Decisions view. Preserve bookmarks without maintaining a second work queue.
type SP = { searchParams: Promise<Record<string, string | string[] | undefined>> }
export default async function AlertsRedirect({ searchParams }: SP) {
  await requireOwner()

  const entries = Object.entries(await searchParams).filter(([, v]) => typeof v === 'string') as [string, string][]
  const qs = new URLSearchParams(entries).toString()
  redirect(qs ? `/decisions?view=tracking_repair&${qs}` : '/decisions?view=tracking_repair')
}
