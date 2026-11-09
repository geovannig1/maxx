import 'server-only'
import { metaAdPlatform } from './meta'
import type { AdPlatform, AdPlatformCapability, AdPlatformId } from './types'

// The ad-platform registry. Core code asks for a platform by id and calls its
// operations; it never imports a platform's modules. Registering a second platform means adding its
// id to AdPlatformId and its implementation below; nothing in the core changes.
//
// Until ad accounts record which platform they belong to, every account is a Meta account, so core
// callers ask for getAdPlatform('meta') explicitly rather than through an implicit default.

const PLATFORMS: Readonly<Record<AdPlatformId, AdPlatform>> = {
  meta: metaAdPlatform,
}

/** Every operation group, in a stable order (UI and engine iterate it to show support). */
export const AD_PLATFORM_CAPABILITIES = [
  'entities', 'insights', 'pacing', 'breakdowns', 'daypart', 'conversions', 'writes', 'campaignCreation', 'adLibrary',
  'trackingHealth', 'datasetDiagnostics', 'recommendations', 'deliveryEstimate', 'connectionCheck',
  'reporting',
] as const satisfies readonly AdPlatformCapability[]

// Compile-time check that the list above names every group of AdPlatform.
type UnlistedCapability = Exclude<AdPlatformCapability, (typeof AD_PLATFORM_CAPABILITIES)[number]>
const everyCapabilityListed: [UnlistedCapability] extends [never] ? true : never = true
void everyCapabilityListed

export class UnknownAdPlatformError extends Error {
  constructor(id: string) {
    super(`Unknown ad platform "${id}"`)
    this.name = 'UnknownAdPlatformError'
  }
}

export class UnsupportedCapabilityError extends Error {
  constructor(platform: AdPlatform, capability: AdPlatformCapability) {
    super(`${platform.label} does not support ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

export function getAdPlatform(id: AdPlatformId): AdPlatform {
  const platform = Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : undefined
  if (!platform) throw new UnknownAdPlatformError(id)
  return platform
}

export function listAdPlatforms(): AdPlatform[] {
  return Object.values(PLATFORMS)
}

/** Capability flags, derived from the groups a platform implements (so they cannot drift from it). */
export function capabilitiesOf(platform: AdPlatform): Record<AdPlatformCapability, boolean> {
  return Object.fromEntries(
    AD_PLATFORM_CAPABILITIES.map((capability) => [capability, platform[capability] !== undefined]),
  ) as Record<AdPlatformCapability, boolean>
}

/** The operations of one capability, or an UnsupportedCapabilityError naming what is missing. */
export function requireCapability<K extends AdPlatformCapability>(
  platform: AdPlatform,
  capability: K,
): NonNullable<AdPlatform[K]> {
  const operations = platform[capability]
  if (operations === undefined) throw new UnsupportedCapabilityError(platform, capability)
  return operations as NonNullable<AdPlatform[K]>
}
