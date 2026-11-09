import { createHash } from 'node:crypto'

// CREATIVE IDENTITY AND DIVERSITY — deterministic, no LLM.
//
// WHY: two ads running the SAME byte-identical video in a Cold set and a Warm set are one asset
// tested twice, not two independent creative tests. Counting them as two inflates apparent creative
// diversity, and any "we've tested N creatives" claim built on ad count is wrong by construction.
//
// Everything here is computed from metadata the API already returns. NOTHING is inferred by an LLM,
// and no numeric performance evidence is ever invented — an LLM may LABEL an angle, but a label is
// recorded as a supplied tag with its own provenance, never as a measurement.

export type MediaKind = 'video' | 'image' | 'carousel' | 'unknown'

export interface CreativeMetadata {
  adId: string
  adsetId: string | null
  creativeId: string | null
  /** Meta video id, image hash, or another stable asset identifier. */
  mediaId: string | null
  mediaKind: MediaKind
  /** Bytes/size of the underlying asset when known — part of the content hash. */
  mediaBytes: number | null
  /** A checksum supplied by the source, when available. Strongest hash input. */
  mediaChecksum: string | null
  durationSeconds: number | null
  width: number | null
  height: number | null
  /** Placements the ad is eligible for, as Meta reports them. */
  placements: string[]
  /** Explicitly supplied by the owner/import; NEVER inferred. */
  conceptId: string | null
  creatorId: string | null
  hookStyle: string | null
  offerTags: string[]
  proofTags: string[]
  ctaTags: string[]
  /** Null when safe-zone compliance is not measurable from available metadata. */
  safeZoneOk: boolean | null
}

export interface CreativeIdentity {
  adId: string
  /** Stable hash of the MEDIA CONTENT. Identical bytes -> identical hash, across ads and ad sets. */
  contentHash: string
  /** How strong the hash inputs were — a hash built only from an id is weaker than one from a checksum. */
  hashBasis: 'checksum' | 'media_id_and_size' | 'media_id_only' | 'insufficient'
  aspectRatio: string | null
  durationSeconds: number | null
  mediaKind: MediaKind
  placements: string[]
  /** Placements a 9:16 vertical asset is a poor fit for, and vice versa. */
  placementFitWarnings: string[]
  conceptId: string | null
  creatorId: string | null
  hookStyle: string | null
  offerTags: string[]
  proofTags: string[]
  ctaTags: string[]
  safeZoneOk: boolean | null
  /** Metadata fields that were absent — every one lowers what can be concluded. */
  missingMetadata: string[]
}

/** PURE: a stable content hash. Distinguishes "same asset" from "same id we happen to know". */
export function computeContentHash(m: CreativeMetadata): { hash: string; basis: CreativeIdentity['hashBasis'] } {
  if (m.mediaChecksum && m.mediaChecksum.trim() !== '') {
    return { hash: sha(`checksum:${m.mediaChecksum.trim()}`), basis: 'checksum' }
  }
  if (m.mediaId && m.mediaBytes !== null) {
    return { hash: sha(`id+size:${m.mediaId}:${m.mediaBytes}:${m.durationSeconds ?? ''}`), basis: 'media_id_and_size' }
  }
  if (m.mediaId) {
    return { hash: sha(`id:${m.mediaId}`), basis: 'media_id_only' }
  }
  // No asset identity at all: hash the AD id so it can never collide with another ad and be
  // mistaken for a duplicate.
  return { hash: sha(`ad:${m.adId}`), basis: 'insufficient' }
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

/** PURE: reduce a width/height to a simple ratio label. */
export function aspectRatioOf(width: number | null, height: number | null): string | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null
  const g = gcd(width, height)
  return `${Math.round(width / g)}:${Math.round(height / g)}`
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

// Placement fit is deterministic geometry, not taste.
const VERTICAL_ONLY = new Set(['instagram_stories', 'instagram_reels', 'facebook_stories', 'facebook_reels'])
const HORIZONTAL_FRIENDLY = new Set(['instream_video', 'facebook_instream_video', 'audience_network'])

/** PURE: geometry-based placement warnings. Silent on anything not determinable. */
export function placementFit(aspect: string | null, placements: string[]): string[] {
  if (aspect === null) return []
  const [w, h] = aspect.split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) return []
  const ratio = w / h
  const warnings: string[] = []
  for (const p of placements) {
    const key = p.toLowerCase()
    if (VERTICAL_ONLY.has(key) && ratio > 0.7) {
      warnings.push(`${p} expects a vertical asset; this creative is ${aspect}`)
    }
    if (HORIZONTAL_FRIENDLY.has(key) && ratio < 0.8) {
      warnings.push(`${p} favours horizontal/square; this creative is ${aspect}`)
    }
  }
  return warnings
}

/** PURE: metadata -> identity. Missing fields are listed, never filled in. */
export function buildCreativeIdentity(m: CreativeMetadata): CreativeIdentity {
  const { hash, basis } = computeContentHash(m)
  const aspect = aspectRatioOf(m.width, m.height)
  const missing: string[] = []
  if (m.mediaId === null) missing.push('mediaId')
  if (m.mediaChecksum === null) missing.push('mediaChecksum')
  if (m.durationSeconds === null && m.mediaKind === 'video') missing.push('durationSeconds')
  if (aspect === null) missing.push('dimensions')
  if (m.placements.length === 0) missing.push('placements')
  if (m.conceptId === null) missing.push('conceptId')
  if (m.creatorId === null) missing.push('creatorId')
  if (m.hookStyle === null) missing.push('hookStyle')
  if (m.safeZoneOk === null) missing.push('safeZone')

  return {
    adId: m.adId,
    contentHash: hash,
    hashBasis: basis,
    aspectRatio: aspect,
    durationSeconds: m.durationSeconds,
    mediaKind: m.mediaKind,
    placements: m.placements,
    placementFitWarnings: placementFit(aspect, m.placements),
    conceptId: m.conceptId,
    creatorId: m.creatorId,
    hookStyle: m.hookStyle,
    offerTags: m.offerTags,
    proofTags: m.proofTags,
    ctaTags: m.ctaTags,
    safeZoneOk: m.safeZoneOk,
    missingMetadata: missing,
  }
}

export interface DuplicateGroup {
  contentHash: string
  hashBasis: CreativeIdentity['hashBasis']
  adIds: string[]
  adsetIds: (string | null)[]
  /** True when the same asset runs in MORE THAN ONE ad set — one asset, not two tests. */
  spansMultipleAdsets: boolean
}

export interface DiversityReport {
  totalAds: number
  /** Count of DISTINCT assets — the honest denominator for "how many creatives are we testing". */
  distinctAssets: number
  duplicates: DuplicateGroup[]
  distinctConcepts: number | null
  distinctCreators: number | null
  distinctHookStyles: number | null
  distinctAspectRatios: number
  /** Ads whose identity rests on weak hash inputs — duplicate detection is less certain for them. */
  weakIdentityAds: string[]
  notes: string[]
}

/**
 * PURE: duplicate + diversity analysis. A byte-identical video reused in Cold and Warm is ONE asset.
 * Counts that cannot be established (no concept ids supplied, etc.) return null, never a guess.
 */
export function analyzeCreativeDiversity(
  metas: CreativeMetadata[],
): DiversityReport {
  const identities = metas.map(buildCreativeIdentity)
  const byHash = new Map<string, { ids: string[]; adsets: (string | null)[]; basis: CreativeIdentity['hashBasis'] }>()
  for (const [i, id] of identities.entries()) {
    const entry = byHash.get(id.contentHash) ?? { ids: [], adsets: [], basis: id.hashBasis }
    entry.ids.push(id.adId)
    entry.adsets.push(metas[i].adsetId)
    byHash.set(id.contentHash, entry)
  }

  const duplicates: DuplicateGroup[] = []
  for (const [hash, e] of byHash) {
    if (e.ids.length < 2) continue
    duplicates.push({
      contentHash: hash,
      hashBasis: e.basis,
      adIds: e.ids,
      adsetIds: e.adsets,
      spansMultipleAdsets: new Set(e.adsets.filter((a) => a !== null)).size > 1,
    })
  }

  const notes: string[] = []
  for (const d of duplicates) {
    notes.push(
      `${d.adIds.length} ads share one media asset (${d.adIds.join(', ')})` +
      (d.spansMultipleAdsets ? ' across MORE THAN ONE ad set — this is the same asset tested twice, not two independent creative tests' : ''),
    )
  }

  const distinctOrNull = (vals: (string | null)[]): number | null => {
    const known = vals.filter((v): v is string => v !== null)
    return known.length === 0 ? null : new Set(known).size
  }

  const weak = identities.filter((i) => i.hashBasis === 'media_id_only' || i.hashBasis === 'insufficient').map((i) => i.adId)
  if (weak.length > 0) {
    notes.push(`${weak.length} ad(s) have weak asset identity (no checksum or size) — duplicate detection for them is lower confidence`)
  }
  const missingConcepts = identities.filter((i) => i.conceptId === null).length
  if (missingConcepts > 0) {
    notes.push(`${missingConcepts} ad(s) have no supplied concept/angle id — concept diversity cannot be fully established, and is NOT inferred`)
  }

  return {
    totalAds: metas.length,
    distinctAssets: byHash.size,
    duplicates,
    distinctConcepts: distinctOrNull(identities.map((i) => i.conceptId)),
    distinctCreators: distinctOrNull(identities.map((i) => i.creatorId)),
    distinctHookStyles: distinctOrNull(identities.map((i) => i.hookStyle)),
    distinctAspectRatios: new Set(identities.map((i) => i.aspectRatio).filter((a): a is string => a !== null)).size,
    weakIdentityAds: weak,
    notes,
  }
}
