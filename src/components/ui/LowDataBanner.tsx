import { LowDataNotice } from './LowDataNotice'
import { assessLowData } from '@/lib/ui/low-data'

// Drop-in "still warming up" banner for entity pages: renders nothing unless the account is DELIVERING
// but still too thin for confident calls (so it never fires on a genuinely empty/dormant view — that's
// the EmptyState's job). One component, one classifier (assessLowData), consistent copy everywhere.
export function LowDataBanner({
  spend,
  bookings,
  windowDays,
  entity,
}: {
  spend: number
  bookings?: number | null
  windowDays: number
  entity: string
}) {
  const ld = assessLowData({ spend, bookings, windowDays, entityPlural: entity })
  if (!ld.warming) return null
  return <LowDataNotice title={ld.title} message={ld.message} items={ld.items} />
}
