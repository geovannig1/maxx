export interface AudienceRef {
  id: string
  name: string | null
  subtype: string | null
  accountId: string | null
  sourceAudienceId?: string | null
  sourceAudienceName?: string | null
  approximateCountLowerBound?: number | null
  approximateCountUpperBound?: number | null
  retentionDays?: number | null
  operationStatus?: unknown
  deliveryStatus?: unknown
  lastSyncedAt?: string | null
}

export interface AudienceReadinessFinding {
  audienceId: string
  role: 'included' | 'excluded'
  operationStatusCode: number | null
  deliveryStatusCode: number | null
  observedAt: string | null
  state: 'unhealthy' | 'unknown'
  failureStatus: 'operation' | 'delivery' | null
}

export type AudienceReferenceOutcome =
  | { kind: 'resolved'; ref: AudienceRef }
  | { kind: 'unresolved'; ref: AudienceRef }
  | { kind: 'unhealthy'; ref: AudienceRef; detail: string }
  | { kind: 'rejected'; ref: AudienceRef }
  | { kind: 'empty' }

export function audienceStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') return null
  const rawCode = (value as Record<string, unknown>).code
  if ((typeof rawCode !== 'number' && typeof rawCode !== 'string')
      || (typeof rawCode === 'string' && rawCode.trim() === '')) return null
  const code = Number(rawCode)
  return Number.isFinite(code) ? code : null
}

function observedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return value
}

export function audienceReadinessFinding(
  outcome: AudienceReferenceOutcome,
  role: AudienceReadinessFinding['role'],
): AudienceReadinessFinding | null {
  if (outcome.kind === 'empty' || outcome.kind === 'resolved' || outcome.kind === 'rejected') {
    return null
  }
  const operationStatusCode = audienceStatusCode(outcome.ref.operationStatus)
  const deliveryStatusCode = audienceStatusCode(outcome.ref.deliveryStatus)
  if (outcome.kind === 'unresolved'
      && operationStatusCode !== null && deliveryStatusCode !== null) return null
  const failureStatus = outcome.kind === 'unhealthy'
    ? operationStatusCode !== null && operationStatusCode !== 200 ? 'operation' : 'delivery'
    : null
  return {
    audienceId: outcome.ref.id,
    role,
    operationStatusCode,
    deliveryStatusCode,
    observedAt: observedAt(outcome.ref.lastSyncedAt),
    state: outcome.kind === 'unhealthy' ? 'unhealthy' : 'unknown',
    failureStatus,
  }
}

/** Resolve identity and Meta-side readiness without conflating an absent status with a failed one. */
export function resolveAudienceReference(
  raw: unknown,
  lookup: Record<string, AudienceRef> | undefined,
  accountId: string,
  evidence: string[],
  nowMs: number,
  maxAgeHours: number,
): AudienceReferenceOutcome {
  const obj = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null
  const id = obj ? String(obj.id ?? '') : String(raw ?? '')
  if (!id) return { kind: 'empty' }
  const known = lookup?.[id]
  const ref: AudienceRef = known ?? {
    id,
    name: obj && typeof obj.name === 'string' ? obj.name : null,
    subtype: null,
    accountId: null,
  }
  if (ref.accountId !== null && ref.accountId !== accountId) {
    evidence.push(`audience ${id} is owned by a DIFFERENT account (${ref.accountId}) — cross-account relationships fail closed; composition cannot be established while it is referenced`)
    return { kind: 'rejected', ref }
  }
  if (ref.accountId === null) {
    evidence.push(`audience ${id} has NO recorded owning account — ownership is UNCONFIRMED, so it cannot be counted as this account's inventory (fail closed)`)
    return { kind: 'unresolved', ref }
  }
  if (ref.subtype === null) {
    evidence.push(`audience ${id} has no resolved subtype (no custom_audiences metadata) — its kind is UNKNOWN, so composition cannot be established`)
    return { kind: 'unresolved', ref }
  }
  const syncedMs = typeof ref.lastSyncedAt === 'string' ? Date.parse(ref.lastSyncedAt) : Number.NaN
  if (!Number.isFinite(syncedMs)) {
    evidence.push(`audience ${id} inventory age is UNKNOWN — readiness and delivery cannot be established`)
    return { kind: 'unresolved', ref }
  }
  const inventoryAgeHours = (nowMs - syncedMs) / 3_600_000
  if (inventoryAgeHours < 0 || inventoryAgeHours > maxAgeHours) {
    evidence.push(`audience ${id} metadata is stale or invalid (${inventoryAgeHours.toFixed(1)}h) — readiness cannot be established`)
    return { kind: 'unresolved', ref }
  }

  const operationCode = audienceStatusCode(ref.operationStatus)
  const deliveryCode = audienceStatusCode(ref.deliveryStatus)
  if (operationCode !== null && operationCode !== 200) {
    const detail = `audience ${id} (${ref.name ?? 'unnamed'}, ${ref.subtype}) operation status ${operationCode} is not ready (expected 200) — Meta could not build it, so it is in the targeting but contributes no reachable people`
    evidence.push(detail)
    return { kind: 'unhealthy', ref, detail }
  }
  if (deliveryCode !== null && deliveryCode !== 200) {
    const detail = `audience ${id} (${ref.name ?? 'unnamed'}, ${ref.subtype}) delivery status ${deliveryCode} is not ready (expected 200) — it is in the targeting but is not delivering`
    evidence.push(detail)
    return { kind: 'unhealthy', ref, detail }
  }
  if (operationCode === null) {
    evidence.push(`audience ${id} (${ref.name ?? 'unnamed'}, ${ref.subtype}) has no operation status — its readiness was never synced, so whether Meta built it is UNKNOWN and composition cannot be established`)
    return { kind: 'unresolved', ref }
  }
  if (deliveryCode === null) {
    evidence.push(`audience ${id} (${ref.name ?? 'unnamed'}, ${ref.subtype}) has no delivery status — its delivery was never synced, so whether it is reaching anyone is UNKNOWN and composition cannot be established`)
    return { kind: 'unresolved', ref }
  }
  return { kind: 'resolved', ref }
}
