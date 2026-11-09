import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import type { Ga4IdentifiedBookingEvents } from '@/lib/ga4/client'
import { buildExecutiveEvidenceSnapshotV1 } from './executive-evidence'
import {
  readExecutiveOutcomeEvidenceV1,
  readExecutiveCapiEvidenceV1,
  readExecutiveGaIdentityEvidenceV1,
  readExecutivePaidCohortEvidenceV1,
  readExecutiveTrackingEvidenceV1,
} from './executive-evidence-business-readers'
import {
  readExecutiveMetaColdWarmV1,
  readExecutiveMetaEvidenceV1,
  readExecutiveMetaPlacementsV1,
} from './executive-evidence-meta-reader'
import { readExecutiveSetupEvidenceV1 } from './executive-evidence-setup-reader'
import type {
  ExecutiveEvidenceReadersV1,
  ExecutiveEvidenceSnapshotInputV1,
  ExecutiveEvidenceSnapshotV1,
  ExecutiveMetaOutcomePlaneV1,
} from './executive-evidence.types'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export interface ExecutiveEvidenceProductionOptionsV1 {
  db?: SupabaseClient
  env?: Record<string, string | undefined>
  gaReader?: (startDate: string, endDate: string) => Promise<Ga4IdentifiedBookingEvents>
  /** undefined = no current sync boundary; null = current sync failed to commit setup history. */
  currentRunSetupGenerationId?: string | null
  /** When present, core source heads must prove they were refreshed by this exact lifecycle run. */
  currentRunSourceNotBefore?: string
  /** Current-run outcome reconciliation. Incomplete nulls Meta outcome facts but retains delivery. */
  currentRunMetaOutcomePlane?: ExecutiveMetaOutcomePlaneV1
}

export interface ExecutiveEvidenceCoreFailuresV1 {
  meta?: Error
  outcomes?: Error
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** A current report may degrade optional planes, but it cannot publish from a failed/stale core
 * business or delivery read. This prevents a new email from silently reusing prior warehouse rows. */
export function assertExecutiveReportCoreSourcesV1(
  snapshot: ExecutiveEvidenceSnapshotV1,
  failures: ExecutiveEvidenceCoreFailuresV1 = {},
  currentRunSourceNotBefore?: string,
): void {
  if (failures.meta) {
    throw new Error(`Meta delivery evidence unavailable: ${failures.meta.message}`)
  }
  if (failures.outcomes) {
    throw new Error(`outcome business ledger evidence unavailable: ${failures.outcomes.message}`)
  }
  if (snapshot.sources.meta.availability === 'unavailable' || !snapshot.meta?.byWindow.lastDay) {
    throw new Error(
      'Meta delivery evidence unavailable: no authoritative account-level row was returned for the last complete day',
    )
  }
  if (snapshot.sources.outcomes.availability === 'unavailable' || !snapshot.outcomes?.byWindow.lastDay) {
    throw new Error(
      `outcome business ledger evidence unavailable: no authoritative active-${OW.one} facts were returned for the last complete day`,
    )
  }
  if (currentRunSourceNotBefore) {
    const boundary = Date.parse(currentRunSourceNotBefore)
    if (!Number.isFinite(boundary)) {
      throw new Error('Current sync source boundary is invalid')
    }
    const metaHead = snapshot.sources.meta.head ? Date.parse(snapshot.sources.meta.head) : Number.NaN
    if (!Number.isFinite(metaHead) || metaHead < boundary) {
      throw new Error(
        'Meta delivery evidence unavailable: no authoritative account-level row was returned from the current sync',
      )
    }
    const outcomeHead = snapshot.sources.outcomes.head ? Date.parse(snapshot.sources.outcomes.head) : Number.NaN
    if (!Number.isFinite(outcomeHead) || outcomeHead < boundary) {
      throw new Error(
        'outcome business ledger evidence unavailable: no current-sync reconciliation head was returned',
      )
    }
  }
}

/**
 * Production, read-only evidence wiring. Each closure caches only within one snapshot build so all
 * dependent surfaces share the same setup and account-level Meta reads.
 */
export function createExecutiveEvidenceProductionReadersV1(
  db: SupabaseClient,
  options: Omit<ExecutiveEvidenceProductionOptionsV1, 'db'> = {},
  coreFailures: ExecutiveEvidenceCoreFailuresV1 = {},
): ExecutiveEvidenceReadersV1 {
  let setupRead: ReturnType<typeof readExecutiveSetupEvidenceV1> | null = null
  let metaRead: ReturnType<typeof readExecutiveMetaEvidenceV1> | null = null
  const setup = (request: Parameters<typeof readExecutiveSetupEvidenceV1>[1]) => {
    setupRead ??= readExecutiveSetupEvidenceV1(db, request, {
      currentRunSetupGenerationId: options.currentRunSetupGenerationId,
    })
    return setupRead
  }
  const meta = (request: Parameters<typeof readExecutiveMetaEvidenceV1>[1]) => {
    metaRead ??= readExecutiveMetaEvidenceV1(
      db,
      request,
      options.currentRunSourceNotBefore,
      options.currentRunMetaOutcomePlane,
    ).catch((error) => {
      coreFailures.meta = errorOf(error)
      throw error
    })
    return metaRead
  }
  return {
    projectSetupChanges: setup,
    readOutcome: (request) => readExecutiveOutcomeEvidenceV1(db, request).catch((error) => {
      coreFailures.outcomes = errorOf(error)
      throw error
    }),
    readMeta: meta,
    readMetaColdWarm: async (request) => {
      const [setupEvidence, metaEvidence] = await Promise.all([setup(request), meta(request)])
      if (!setupEvidence.data) {
        return {
          availability: 'unavailable',
          head: setupEvidence.head,
          blockerCodes: ['setup_projection_unavailable'],
          data: null,
        }
      }
      const authoritativeSpend = metaEvidence.data?.byWindow.trailing7?.spendAmount ?? null
      return readExecutiveMetaColdWarmV1(
        db,
        request,
        setupEvidence.data,
        authoritativeSpend,
        options.currentRunSourceNotBefore,
        options.currentRunMetaOutcomePlane,
      )
    },
    readMetaPlacements: async (request) => {
      const metaEvidence = await meta(request)
      const authoritative = metaEvidence.data?.byWindow.trailing7 ?? null
      return readExecutiveMetaPlacementsV1(
        db,
        request,
        authoritative?.spendAmount ?? null,
        options.currentRunSourceNotBefore,
        options.currentRunMetaOutcomePlane,
        {
          leads: authoritative?.leads ?? null,
          modeledBookings: authoritative?.modeledBookings ?? null,
        },
      )
    },
    readTracking: async (request) => {
      const metaEvidence = await meta(request)
      const landingPageViews = metaEvidence.data?.byWindow.trailing7?.landingPageViews ?? null
      return readExecutiveTrackingEvidenceV1(db, request, landingPageViews)
    },
    readCapi: (request) => readExecutiveCapiEvidenceV1(db, request, options.env),
    readGaIdentity: (request) => readExecutiveGaIdentityEvidenceV1(db, request, options.gaReader),
    readPaidCohort: (request) => readExecutivePaidCohortEvidenceV1(db, request),
  }
}

/** Read-only production adapter for report generators. It does not persist or send the snapshot. */
export async function buildExecutiveEvidenceForReport(
  input: ExecutiveEvidenceSnapshotInputV1,
  options: ExecutiveEvidenceProductionOptionsV1 = {},
): Promise<ExecutiveEvidenceSnapshotV1> {
  const db = options.db ?? getAdminClient()
  const coreFailures: ExecutiveEvidenceCoreFailuresV1 = {}
  const snapshot = await buildExecutiveEvidenceSnapshotV1(
    input,
    createExecutiveEvidenceProductionReadersV1(db, options, coreFailures),
  )
  assertExecutiveReportCoreSourcesV1(snapshot, coreFailures, options.currentRunSourceNotBefore)
  return snapshot
}
