import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

// Tasks are a filtered Decisions view. Preserve bookmarks without maintaining a second work queue.
type SP = { searchParams: Promise<Record<string, string | string[] | undefined>> }
export default async function TasksRedirect({ searchParams }: SP) {
  await requireOwner()

  const entries = Object.entries(await searchParams).filter(([, v]) => typeof v === 'string') as [string, string][]
  const qs = new URLSearchParams(entries).toString()
  redirect(qs ? `/decisions?view=awaiting_implementation&${qs}` : '/decisions?view=awaiting_implementation')
}
