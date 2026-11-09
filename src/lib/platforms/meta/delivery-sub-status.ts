import type { MetaDeliverySubStatus } from '@/types/meta-api'

export const DELIVERY_SUB_STATUS_FIELD = 'delivery_sub_status'

export type DeliverySubStatusRead =
  | { read_available: true; payload: MetaDeliverySubStatus | null }
  | { read_available: false; payload: null }

export type DeliverySubStatusEvidence =
  | { read_available: true; payload: MetaDeliverySubStatus | null; synced_at: string }
  | { read_available: false; payload: null; synced_at: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizePayload(value: unknown): MetaDeliverySubStatus | null | undefined {
  if (!isRecord(value)) return undefined

  const status = value.status
  const substatuses = value.substatuses
  if (status !== undefined && status !== null && typeof status !== 'string') return undefined
  if (substatuses !== undefined && (
    !Array.isArray(substatuses) || substatuses.some((item) => typeof item !== 'string')
  )) return undefined

  return {
    status: typeof status === 'string' ? status : null,
    substatuses: Array.isArray(substatuses) ? substatuses : [],
  }
}

function isNormalizedPayload(value: unknown): value is MetaDeliverySubStatus {
  return isRecord(value)
    && (value.status === null || typeof value.status === 'string')
    && Array.isArray(value.substatuses)
    && value.substatuses.every((item) => typeof item === 'string')
}

export function normalizeDeliverySubStatus(
  value: unknown,
  fieldRequested: boolean,
): DeliverySubStatusRead {
  if (!fieldRequested) return { read_available: false, payload: null }
  if (value === undefined || value === null) return { read_available: true, payload: null }
  const payload = normalizePayload(value)
  return payload === undefined
    ? { read_available: false, payload: null }
    : { read_available: true, payload }
}

export function unavailableDeliverySubStatusEvidence(): DeliverySubStatusEvidence {
  return { read_available: false, payload: null, synced_at: null }
}

export function isDeliverySubStatusEvidence(value: unknown): value is DeliverySubStatusEvidence {
  if (!isRecord(value)) return false
  if (value.read_available === false) {
    return value.payload === null && value.synced_at === null
  }
  if (value.read_available !== true) return false
  if (typeof value.synced_at !== 'string' || !Number.isFinite(Date.parse(value.synced_at))) return false
  if (value.payload === null) return true
  return isNormalizedPayload(value.payload)
}

export function normalizePersistedDeliverySubStatus(
  payload: unknown,
  readAvailable: unknown,
  syncedAt: unknown,
): DeliverySubStatusEvidence {
  const candidate = {
    read_available: readAvailable,
    payload,
    synced_at: syncedAt,
  }
  if (!isDeliverySubStatusEvidence(candidate)) return unavailableDeliverySubStatusEvidence()
  if (!candidate.read_available) return unavailableDeliverySubStatusEvidence()
  return {
    read_available: true,
    payload: candidate.payload,
    synced_at: candidate.synced_at,
  }
}
