import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

// Compatibility-only route: Decisions is the sole operational owner queue.
export default async function InboxPage() {
  await requireOwner()

  redirect('/decisions?view=tracking_repair&legacy=inbox')
}
