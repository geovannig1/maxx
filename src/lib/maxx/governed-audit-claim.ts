import {
  MetricClaimSchema,
  assertNoCrossPlaneLineage,
  createMetricClaim,
  type MetricClaim,
  type MetricClaimInput,
} from '@/lib/cockpit/contracts'
import type { MaxxAuditFocus } from './audit-focus'
import { availability, record } from './governed-audit-source'
import { accountTimezone } from '@/config/business-config'

// The claim builder and input/output shapes of the governed audit packet (governed-audit.ts).

export interface GovernedAuditBuildInput {
  focus: MaxxAuditFocus
  accountId: string
  window: { start: string; end: string }
  asOf: string
  cockpit: unknown
  diagnosis: unknown
  reconciliation: unknown
  economics: unknown
  operatingMode: unknown
  recommendations: unknown
  creative: unknown
}

export interface GovernedAuditEvidence {
  claims: MetricClaim[]
  required_claim_ids: string[]
  persisted_final_action_decisions: unknown[]
}

export function claim(input: GovernedAuditBuildInput, args: {
  metricKey: string
  label: string
  value: number | string | null
  unit: MetricClaimInput['unit']
  system: MetricClaimInput['source']['system']
  role: MetricClaimInput['source']['role']
  plane: MetricClaimInput['source']['evidencePlane']
  level: MetricClaimInput['entity']['level']
  entityId: string
  scope: MetricClaimInput['attributionScope']
  measurementKind: MetricClaimInput['measurementKind']
  authority?: MetricClaimInput['authority']['state']
  basis?: MetricClaimInput['window']['basis']
  window?: { start: string; end: string; basis?: MetricClaimInput['window']['basis'] } | null
  sourceHead?: string
  observedAt?: string | null
  discriminator?: string
  blockerCode?: string
}): MetricClaim {
  const claimWindow = args.window ?? input.window
  const discriminator = args.discriminator ? `:${args.discriminator}` : ''
  const suffix = `${args.plane}:${args.level}:${args.entityId}:${claimWindow.start}:${claimWindow.end}${discriminator}`
  const item = createMetricClaim({
    claimId: `maxx.audit.${args.metricKey}:${suffix}`,
    metricKey: args.metricKey,
    label: args.label,
    value: args.blockerCode ? null : args.value,
    unit: args.unit,
    formula: null,
    definitionVersion: 1,
    source: {
      system: args.system,
      role: args.role,
      head: args.sourceHead ?? `get_governed_audit:${input.asOf}`,
      evidencePlane: args.plane,
    },
    entity: { level: args.level, id: args.entityId },
    attributionScope: args.scope,
    window: {
      start: claimWindow.start,
      end: claimWindow.end,
      basis: args.basis ?? args.window?.basis ?? 'closed_account_days',
      timezone: accountTimezone(),
    },
    comparison: { method: 'none', window: null },
    asOf: input.asOf,
    availability: availability(args.blockerCode),
    coverage: { state: 'unknown', numerator: null, denominator: null },
    maturity: {
      state: args.unit === 'state' ? 'not_applicable' : 'partial',
      matureThrough: args.unit === 'state' ? null : claimWindow.end,
    },
    freshness: { state: 'unknown', observedAt: args.observedAt ?? null, maxAgeHours: null },
    setupFingerprint: null,
    authority: {
      state: args.blockerCode ? 'blocked' : args.authority ?? 'diagnostic',
      policyVersion: 'maxx-governed-audit-v1',
    },
    measurementKind: args.measurementKind,
    inputClaimIds: [],
  })
  assertNoCrossPlaneLineage({ [item.claimId]: item })
  return item
}

export function cockpitClaims(value: unknown): MetricClaim[] {
  const row = record(value)
  const raw = row?.claims
  const rawRecord = record(raw)
  const candidates = Array.isArray(raw)
    ? raw
    : rawRecord ? Object.values(rawRecord) : []
  const parsed: MetricClaim[] = []
  for (const candidate of candidates) {
    const result = MetricClaimSchema.safeParse(candidate)
    if (result.success) parsed.push(result.data)
  }
  return parsed
}
