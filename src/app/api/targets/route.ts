import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  METRIC_RANGES, EDITABLE_RANGE_FIELDS, applyTargetOverrides, mergeRanges, validateRangeOrdering,
  type MetricKey, type TargetOverrides, type EditableRangeField,
} from '@/lib/targets/target-ranges'
import { loadTargetOverrides, saveTargetOverrides } from '@/lib/targets/store'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// GET — defaults (with labels/units/direction for the editor) + the currently-saved overrides.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const policy = await loadTargetOverrides()
  return Response.json({
    defaults: METRIC_RANGES,
    overrides: policy.status === 'unversioned' ? policy.overrides : {},
    policy_health: {
      status: policy.status,
      authority_eligible: policy.authorityEligible,
      reason_code: policy.reasonCode,
      reason: policy.reason,
      provenance: policy.provenance,
    },
  })
}

// PUT — save overrides. Only known metrics + editable numeric fields (≥ 0) are accepted; everything
// else is dropped, so a malformed body can't corrupt the active ranges.
export async function PUT(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid body' }, { status: 400 })

  const clean: TargetOverrides = {}
  for (const mk of Object.keys(METRIC_RANGES) as MetricKey[]) {
    const incoming = (body as Record<string, unknown>)[mk]
    if (!incoming || typeof incoming !== 'object') continue
    const fields: Partial<Record<EditableRangeField, number>> = {}
    for (const f of EDITABLE_RANGE_FIELDS) {
      const v = (incoming as Record<string, unknown>)[f]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) fields[f] = v
    }
    if (Object.keys(fields).length > 0) clean[mk] = fields
  }

  // Reject inverted band edges (e.g. healthy > watch for a lower_is_better metric) — they silently
  // corrupt banding so a bad value reads as good. Validate the EFFECTIVE ranges (defaults + overrides).
  const ordering = validateRangeOrdering(mergeRanges(clean))
  if (!ordering.ok) {
    return Response.json({ error: 'Invalid target ranges — band edges are out of order.', details: ordering.errors }, { status: 400 })
  }

  const res = await saveTargetOverrides(clean)
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 })

  applyTargetOverrides(clean) // take effect immediately for this server process
  return Response.json({
    ok: true,
    overrides: clean,
    policy_health: {
      status: res.policyStatus,
      authority_eligible: res.authorityEligible,
      reason: 'Saved target ranges are diagnostic only until an immutable owner-approved version is implemented.',
    },
  })
}
