import { BUSINESS_PROFILE } from '@/config/business-profile'
import { createHash } from 'crypto'
import { configuredPhoneCallingCode, normalizePhoneDigits } from './phone'

// Shared conversions-API hashing and payload types, used by the outcome conversion senders
// (src/lib/conversions/outcome-conversions.ts and the reference adapter's own sender). The first-party browser relay was removed 2026-07-18; relay-event.ts
// is retained only for buildFbc.
//
// This module ALSO used to hold a three-event builder (Purchase + AppointmentConfirmed + Schedule) for
// an earlier webhook path. It was retired 2026-07-17: the source webhook now feeds the ledger only, and a
// second event stream keyed on a source-derived id would NOT dedup against the pixel's shared event id,
// double-counting AppointmentConfirmed. The PII hashers and payload types below remain.

export interface CapiUserData {
  em?: string[]
  ph?: string[]
  fn?: string[]
  ln?: string[]
  /** Stable person key across outcomes. Sources expose no client id, so this is the email hash. */
  external_id?: string[]
}

export interface CapiEvent {
  event_name: string
  event_time: number
  event_id: string
  event_source_url: string
  action_source: 'website'
  user_data: CapiUserData
  /** The value in the outcome's own ISO 4217 currency (the ad account currency). */
  custom_data?: { value: number; currency: string }
}

export interface CapiPayload {
  data: CapiEvent[]
  test_event_code?: string
}

/** The booking page both the ads and the embedded scheduler flow live on. */
export const BOOKING_PAGE_URL = BUSINESS_PROFILE.bookingPageUrl

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Meta-spec normalization + hash. Returns undefined for empty/blank input (never hash empty strings). */
export function hashEmail(email: string | null | undefined): string | undefined {
  const v = (email ?? '').trim().toLowerCase()
  return v ? sha256(v) : undefined
}

/** Phone: E.164 digits (see ./phone.ts). A number written without a country code gets the configured
 *  default calling code (CONVERSIONS_PHONE_COUNTRY_CODE), or no prefix when none is configured. */
export function hashPhone(
  phone: string | null | undefined,
  callingCode: string | null = configuredPhoneCallingCode(),
): string | undefined {
  const digits = normalizePhoneDigits(phone, callingCode)
  return digits ? sha256(digits) : undefined
}

/** Names: lowercase, trimmed, letters kept as-is (Meta spec: lowercase UTF-8). */
export function hashName(name: string | null | undefined): string | undefined {
  const v = (name ?? '').trim().toLowerCase()
  return v ? sha256(v) : undefined
}

export function parsePrice(price: string | number | null | undefined): number | null {
  if (price === null || price === undefined) return null
  const n = typeof price === 'number' ? price : parseFloat(price)
  return Number.isFinite(n) && n >= 0 ? n : null
}
