import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ownerOnly } from '@/lib/auth/require-owner'
import { loadPerformanceCockpitData } from '@/lib/cockpit/builder'
import { resolveRange } from '@/lib/date-range'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value
}, 'Date must be a real calendar day.')
const querySchema = z.object({
  range: z.enum(['1d', '1w', '1m', 'mtd', 'qtd', 'ytd']).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
}).strict().superRefine((value, context) => {
  if ((value.from === undefined) !== (value.to === undefined)) {
    context.addIssue({ code: 'custom', message: 'from and to must be supplied together' })
  }
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: 'custom', message: 'from must not follow to' })
  }
})

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const parsed = querySchema.safeParse({
    range: request.nextUrl.searchParams.get('range') ?? undefined,
    from: request.nextUrl.searchParams.get('from') ?? undefined,
    to: request.nextUrl.searchParams.get('to') ?? undefined,
  })
  if (!parsed.success) {
    return Response.json({
      error: 'Invalid cockpit date range.',
      issues: parsed.error.issues.map((issue) => issue.message),
    }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  }

  const range = resolveRange(parsed.data, 'mtd')
  if (range.invalidCustom) {
    return Response.json({ error: 'Invalid cockpit date range.' }, {
      status: 400, headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  try {
    const data = await loadPerformanceCockpitData({ range })
    return Response.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return Response.json({ error: 'Performance cockpit is temporarily unavailable.' }, {
      status: 503, headers: { 'Cache-Control': 'private, no-store' },
    })
  }
}
