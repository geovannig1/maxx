import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { buildQualityReport, QualityReportUnavailableError } from '@/lib/diagnostics/quality-report'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

// GET /api/diagnostics/quality?from=&to=
// Per-ad auction quality rankings + diagnostic-only ad-set delivery evidence.
// Body lives in lib/diagnostics/quality-report.ts (shared with the MCP diagnosis tools).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const from = sp.get('from') ?? sp.get('date_start')
  const to = sp.get('to') ?? sp.get('date_end')
  if (!from || !to) return Response.json({ error: 'from and to are required' }, { status: 400 })

  try {
    return Response.json(await buildQualityReport({ from, to }))
  } catch (error) {
    if (error instanceof QualityReportUnavailableError) {
      return Response.json({
        available: false,
        code: error.code,
        reason: error.reason,
      }, { status: 503 })
    }
    throw error
  }
}
