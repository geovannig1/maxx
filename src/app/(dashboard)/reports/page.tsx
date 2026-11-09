import { requireOwner } from '@/lib/auth/page-owner'
import { Suspense } from 'react'
import { ReportingWorkspace } from '@/components/reporting/ReportingWorkspace'

export default async function ReportingPage() {
  await requireOwner()

  return <Suspense fallback={<p role="status" className="p-6 text-sm">Loading reporting controls…</p>}>
    <ReportingWorkspace view="reports" />
  </Suspense>
}
