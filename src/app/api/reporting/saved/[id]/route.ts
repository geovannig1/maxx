import type { NextRequest } from 'next/server'
import { savedReportingRoute } from '@/lib/reporting/saved-route'
export const runtime = 'nodejs'
export const maxDuration = 60
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return savedReportingRoute(request, 'open', (await context.params).id)
}
