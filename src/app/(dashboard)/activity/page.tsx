import { requireOwner } from '@/lib/auth/page-owner'
import { redirect } from 'next/navigation'

// Activity is the immutable decision → implementation → observation → outcome timeline.
export default async function ActivityIndex() {
  await requireOwner()

  redirect('/activity/change-log')
}
