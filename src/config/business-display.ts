// Client-safe business display helpers.
//
// NEXT_PUBLIC_* values are inlined at build time, so these work in both server and client components
// without importing the server-side profile (which reads BUSINESS_PROFILE_JSON and validates it).
// Keep this module dependency-free.

export const DEFAULT_BUSINESS_NAME = 'Example Studio'

/** Business name shown in the UI chrome and page metadata. */
export function businessDisplayName(): string {
  const value = process.env.NEXT_PUBLIC_BUSINESS_NAME?.trim()
  return value && value.length > 0 ? value : DEFAULT_BUSINESS_NAME
}

/** Up to two initials for compact badges (e.g. "Example Studio" → "ES"). */
export function businessInitials(name: string = businessDisplayName()): string {
  const words = name.split(/\s+/).filter(Boolean)
  const letters = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)
  return letters.toUpperCase()
}

// The business timezone and currency have ONE configuration source (business-config.ts).
export { accountTimezone, DEFAULT_BUSINESS_TIMEZONE as DEFAULT_ACCOUNT_TIMEZONE } from './business-config'

/** Hourly rate in the account currency, used only for the competitor comparison panel.
 *  NEXT_PUBLIC_BUSINESS_HOURLY_RATE; the deprecated NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD is still accepted. */
export function businessHourlyRate(): number {
  const value = Number(process.env.NEXT_PUBLIC_BUSINESS_HOURLY_RATE?.trim() || process.env.NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD?.trim() || '')
  return Number.isFinite(value) && value > 0 ? value : 95
}
