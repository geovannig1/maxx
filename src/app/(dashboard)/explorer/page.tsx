import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

// Explorer removed (UX v2). Its automated-insight sections now live on the Performance → Flags tab; kept
// as a redirect so bookmarks + ⌘K history + links never 404.
export default async function ExplorerRedirect() {
  await requireOwner()

  redirect('/performance/flags')
}
