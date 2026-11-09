import type { NextRequest } from 'next/server'
import { savedReportingRoute } from '@/lib/reporting/saved-route'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
export const runtime = 'nodejs'
export const maxDuration = 60
export async function GET(request: NextRequest) { return savedReportingRoute(request, 'list') }
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(request)
  if (crossOrigin) return crossOrigin
  return savedReportingRoute(request, 'save')
}
