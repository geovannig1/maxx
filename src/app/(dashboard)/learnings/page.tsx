import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

// Re-parented into the Activity destination. Kept as a redirect so bookmarks + links never 404.
export default async function LearningsRedirect() {
  await requireOwner()

  redirect('/activity/learnings')
}
