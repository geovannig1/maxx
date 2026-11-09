import { requireOwner } from '@/lib/auth/page-owner'
import { SavedReportsList } from '@/components/reporting/SavedReportsList'

export default async function SavedReportingPage() {
  await requireOwner()
 return <SavedReportsList /> }
