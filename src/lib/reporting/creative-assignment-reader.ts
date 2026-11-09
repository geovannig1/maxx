// Server-only adapter; the client contract imports no database runtime.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getAdminClient } from '@/lib/supabase/admin'
import { readCreativeAssignmentObservations } from '@/lib/creative/paid-outcomes-store'
import type { ReportingContext } from './contracts'
import { validateReportCreativeAssignmentEvidence, type ReportCreativeAssignmentEvidence } from './creative-assignment-contract'
import { ReportingDeadlineError, withReportingDeadline } from './deadline'

export async function readReportCreativeAssignmentEvidence(
  context: ReportingContext, adIds: readonly string[], options: { db?: SupabaseClient } = {},
): Promise<ReportCreativeAssignmentEvidence> {
  const base = { accountId: context.account.id, asOf: context.asOf }
  try {
    z.string().uuid().parse(context.account.id)
    const ids = [...new Set(z.array(z.string().regex(/^\d{1,32}$/)).parse(adIds))]
    const observations = ids.length ? await withReportingDeadline(signal =>
      readCreativeAssignmentObservations(options.db ?? getAdminClient(), context.account.id, ids, { signal }), 5000) : []
    const evidence: ReportCreativeAssignmentEvidence = { ...base, state: 'available', observations, notes: [] }
    validateReportCreativeAssignmentEvidence(context, evidence, ids)
    return evidence
  } catch (error) {
    return { ...base, state: 'unavailable', observations: [], notes: [error instanceof ReportingDeadlineError
      ? 'Creative assignment history exceeded its 5-second read timeout; historical membership is unavailable.'
      : 'Creative assignment history could not be read and validated; historical membership is unavailable.'] }
  }
}
