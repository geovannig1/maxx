import type { MetricClaimInput } from '@/lib/cockpit/contracts'
import { etDateOf } from '@/lib/utils/date-utils'

type RecordValue = Record<string, unknown>

export function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null
}

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[A-Za-z0-9._:-]{1,120}$/.test(trimmed) ? trimmed : null
}

export function safeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^[\p{L}\p{N}][\p{L}\p{N} _&()./-]{0,59}$/u.test(trimmed) ? trimmed : fallback
}

export function nestedSection(value: unknown, key: string): unknown {
  return record(value)?.[key] ?? null
}

export function availability(blockerCode?: string): MetricClaimInput['availability'] {
  return blockerCode
    ? { state: 'unavailable', blockerCodes: [blockerCode] }
    : { state: 'available', blockerCodes: [] }
}

export function sourceWindow(
  value: unknown,
  startKey: string,
  endKey: string,
): { start: string; end: string } | null {
  const row = record(value)
  const start = row?.[startKey]
  const end = row?.[endKey]
  if (typeof start !== 'string' || typeof end !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null
  return start <= end ? { start, end } : null
}

export function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export function instantSourceWindow(
  value: unknown,
  startKey: string,
  endKey: string,
): { start: string; end: string } | null {
  const row = record(value)
  const startInstant = isoInstant(row?.[startKey])
  const endInstant = isoInstant(row?.[endKey])
  if (!startInstant || !endInstant || startInstant > endInstant) return null
  const start = etDateOf(startInstant)
  const end = etDateOf(endInstant)
  return start && end && start <= end ? { start, end } : null
}

export function snapshotWindow(
  instant: string,
): { start: string; end: string; basis: MetricClaimInput['window']['basis'] } | null {
  const date = etDateOf(instant)
  return date ? { start: date, end: date, basis: 'partial_today' } : null
}

export function safeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(trimmed) ? trimmed : null
}

export function deliveryStatusProjection(value: unknown): {
  value: string | null
  observedAt: string | null
  blockerCode?: string
} {
  const status = record(value)
  if (status?.read_available !== true) {
    return { value: null, observedAt: null, blockerCode: 'meta_delivery_sub_status_unavailable' }
  }
  const observedAt = isoInstant(status.synced_at)
  if (!observedAt) {
    return { value: null, observedAt: null, blockerCode: 'meta_delivery_sub_status_unavailable' }
  }
  if (status.payload === null) {
    return { value: 'Meta reported no delivery sub-status', observedAt }
  }
  const payload = record(status.payload)
  const rawSubstatuses = payload?.substatuses
  const statusCode = payload?.status === null ? null : safeCode(payload?.status)
  if (!payload || (payload.status !== null && statusCode === null)
      || !Array.isArray(rawSubstatuses) || rawSubstatuses.length > 8) {
    return { value: null, observedAt: null, blockerCode: 'meta_delivery_sub_status_invalid' }
  }
  const substatuses = rawSubstatuses.map(safeCode)
  if (substatuses.some((code) => code === null)) {
    return { value: null, observedAt: null, blockerCode: 'meta_delivery_sub_status_invalid' }
  }
  const codes = [...new Set(substatuses as string[])]
  const statusLabel = statusCode ? `Meta status ${statusCode}` : 'Meta status unspecified'
  return {
    value: `${statusLabel}; substatuses: ${codes.length > 0 ? codes.join(', ') : 'none'}`,
    observedAt,
  }
}

export interface AudienceReadinessProjection {
  value: string | null
  observedAt: string | null
  authority: 'diagnostic' | 'blocked'
  blockerCode?: string
}

const MAX_AUDIENCE_READINESS_FINDINGS = 4

function statusCode(value: unknown): { valid: boolean; value: number | null } {
  if (value === null) return { valid: true, value: null }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { valid: true, value }
    : { valid: false, value: null }
}

export function audienceReadinessProjections(value: unknown): {
  items: AudienceReadinessProjection[]
  incomplete: boolean
} {
  const rows = record(value)?.audienceReadinessFindings
  if (!Array.isArray(rows)) return { items: [], incomplete: false }
  const items: AudienceReadinessProjection[] = []
  let incomplete = rows.length > MAX_AUDIENCE_READINESS_FINDINGS
  for (const raw of rows.slice(0, MAX_AUDIENCE_READINESS_FINDINGS)) {
    const finding = record(raw)
    const audienceId = safeId(finding?.audienceId)
    const role = finding?.role === 'included' || finding?.role === 'excluded'
      ? finding.role
      : null
    const state = finding?.state === 'unhealthy' || finding?.state === 'unknown'
      ? finding.state
      : null
    const failureStatus = finding?.failureStatus === null
      || finding?.failureStatus === 'operation'
      || finding?.failureStatus === 'delivery'
      ? finding.failureStatus
      : undefined
    const operation = statusCode(finding?.operationStatusCode)
    const delivery = statusCode(finding?.deliveryStatusCode)
    const unhealthyCoherent = state === 'unhealthy'
      && (failureStatus === 'operation' || failureStatus === 'delivery')
      && (failureStatus === 'operation' ? operation.value : delivery.value) !== null
      && (failureStatus === 'operation' ? operation.value : delivery.value) !== 200
    const unknownCoherent = state === 'unknown' && failureStatus === null
      && (operation.value === null || delivery.value === null)
    if (!finding || !audienceId || !role || !operation.valid || !delivery.valid
        || (!unhealthyCoherent && !unknownCoherent)) {
      incomplete = true
      continue
    }
    const observedAt = isoInstant(finding.observedAt)
    if (!observedAt) {
      items.push({
        value: null, observedAt: null, authority: 'blocked',
        blockerCode: 'audience_readiness_provenance_unavailable',
      })
      continue
    }
    const roleLabel = role === 'included' ? 'Included' : 'Excluded'
    const operationLabel = operation.value === null ? 'unavailable' : operation.value
    const deliveryLabel = delivery.value === null ? 'unavailable' : delivery.value
    let detail: string
    if (state === 'unknown') {
      detail = `${roleLabel} audience ${audienceId}: Meta operation status ${operationLabel}; `
        + `delivery status ${deliveryLabel}; readiness unknown; audience and budget conclusions are frozen`
    } else if (role === 'excluded') {
      const failed = failureStatus === 'operation'
        ? `operation status ${operationLabel}`
        : `delivery status ${deliveryLabel}`
      detail = `${roleLabel} audience ${audienceId}: Meta ${failed}; exclusion is not suppressing `
        + 'anyone; this ad set may reach excluded people'
    } else if (failureStatus === 'operation') {
      detail = `${roleLabel} audience ${audienceId}: Meta operation status ${operationLabel}; `
        + `delivery status ${deliveryLabel}; contributes no reachable people`
    } else {
      detail = `${roleLabel} audience ${audienceId}: Meta delivery status ${deliveryLabel}; `
        + `operation status ${operationLabel}; is not delivering`
    }
    items.push({
      value: detail,
      observedAt,
      authority: state === 'unknown' ? 'blocked' : 'diagnostic',
    })
  }
  return { items, incomplete }
}
