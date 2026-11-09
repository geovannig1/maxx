import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { loadEconomicsInputs, saveEconomicsInputs } from '@/lib/economics/settings'
import { proposeCpaBands } from '@/lib/economics/model'
import { CHAMPION_BENCHMARK } from '@/lib/economics/champion'
import { z } from 'zod'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

function historicalChampionAuditContext() {
  return {
    ...CHAMPION_BENCHMARK,
    context_status: 'historical_audit_only' as const,
    action_authority: 'none' as const,
    current_policy: false as const,
    warning:
      'Historical Meta-attributed performance under different measurement conditions. It is not a current target, scaling rule, or money authority.',
  }
}

function proposedBands(inputs: Awaited<ReturnType<typeof loadEconomicsInputs>>) {
  if (inputs.status !== 'available') return null
  const bands = proposeCpaBands(inputs.inputs)
  return bands ? { ...bands, status: 'proposal_only' as const, action_authority: 'none' as const } : null
}

async function authenticateOwner(): Promise<Response | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  return ownerOnly(user)
}

// Owner-gated manual inputs. Existing rows are explicitly unversioned; absent/invalid values remain
// unavailable and never become a fixed AOV or historical-benchmark policy.
export async function GET() {
  const forbidden = await authenticateOwner()
  if (forbidden) return forbidden

  const economicsInputs = await loadEconomicsInputs()
  return Response.json({
    economics_inputs: economicsInputs,
    // Backward-compatible field name, now nullable instead of silently defaulted.
    inputs: economicsInputs.inputs,
    champion: historicalChampionAuditContext(),
    proposed_cpa_bands: proposedBands(economicsInputs),
    note:
      'Manual economics inputs are diagnostic until durable approval/version provenance exists. Proposed bands have no action authority and nothing re-bands automatically.',
  })
}

const economicsUpdateSchema = z.object({
  aov: z.number().finite().positive().optional(),
  gross_margin_rate: z.number().finite().min(0).max(1).nullable().optional(),
  repeat_rate: z.number().finite().min(0).max(1).nullable().optional(),
  source_note: z.string().trim().min(1).max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one economics input is required.' })

export async function PUT(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const forbidden = await authenticateOwner()
  if (forbidden) return forbidden

  const body = await req.json().catch(() => null)
  const parsed = economicsUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid economics inputs', code: 'INVALID_ECONOMICS_INPUTS' }, { status: 400 })
  }

  const result = await saveEconomicsInputs(parsed.data)
  if (!result.ok) {
    const status = result.error_code === 'account_not_found'
      ? 404
      : result.error_code === 'account_ambiguous'
        ? 409
        : result.error_code === 'account_unavailable'
          ? 503
          : 400
    return Response.json({ error: result.error, code: result.error_code ?? 'ECONOMICS_WRITE_FAILED' }, { status })
  }

  const economicsInputs = await loadEconomicsInputs()
  if (economicsInputs.status !== 'available') {
    return Response.json({
      error: 'The economics input was stored but could not be read back safely.',
      code: economicsInputs.reason_code,
      economics_inputs: economicsInputs,
    }, { status: 500 })
  }

  return Response.json({
    ok: true,
    economics_inputs: economicsInputs,
    inputs: economicsInputs.inputs,
    proposed_cpa_bands: proposedBands(economicsInputs),
  })
}
