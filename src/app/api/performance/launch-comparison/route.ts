import { readAdr056LaunchComparison, Adr056LaunchReadError } from '@/lib/launch/adr056-launch-reader'
import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { NextRequest } from 'next/server'
import { yesterday } from '@/lib/utils/date-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
}

export async function GET(req?: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const requestedFrom = req?.nextUrl.searchParams.get('from') ?? null
  const requestedTo = req?.nextUrl.searchParams.get('to') ?? null
  const hasPartialRange = (requestedFrom === null) !== (requestedTo === null)
  const selectedTo = requestedTo ?? yesterday()
  if (
    hasPartialRange
    || (requestedFrom !== null && !isIsoCalendarDate(requestedFrom))
    || !isIsoCalendarDate(selectedTo)
    || selectedTo > yesterday()
    || (requestedFrom !== null && requestedFrom > selectedTo)
  ) {
    return Response.json({
      code: 'INVALID_ADR056_WINDOW',
      error: 'ADR-056 requires a complete, ordered closed-day selected range.',
    }, { status: 400 })
  }

  try {
    const comparison = await readAdr056LaunchComparison({
      lastClosedDate: selectedTo,
      selectedFrom: requestedFrom ?? undefined,
    })
    return Response.json(comparison, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    const code = error instanceof Adr056LaunchReadError
      ? error.code
      : 'ADR056_LAUNCH_COMPARISON_UNAVAILABLE'
    return Response.json({
      code,
      error: 'The ADR-056 launch comparison is unavailable because its source read failed.',
    }, { status: 503 })
  }
}
