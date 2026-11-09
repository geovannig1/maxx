// Segment dimensions for the Segments page. Each maps a human dimension to the Meta breakdown_type
// stored in `insight_breakdowns`. Day-part is handled separately (its own table + heatmap), so it is
// NOT in this list.
//
// Capture status (see fetch-breakdowns.ts + the daily-sync cron):
//   age, gender, publisher_platform  — captured today
//   device_platform, region, platform_position — added; populate on the next nightly sync.

export type SegmentDimension =
  | 'platform'
  | 'placement'
  | 'device'
  | 'age'
  | 'gender'
  | 'region'

export interface DimensionDef {
  key: SegmentDimension
  label: string
  /** breakdown_type value stored in insight_breakdowns */
  breakdownType: string
  description: string
}

export const SEGMENT_DIMENSIONS: DimensionDef[] = [
  { key: 'platform', label: 'Platform', breakdownType: 'publisher_platform', description: 'Facebook / Instagram / Audience Network / Messenger' },
  { key: 'placement', label: 'Placement', breakdownType: 'platform_position', description: 'Feed / Stories / Reels / Marketplace / etc.' },
  { key: 'device', label: 'Device', breakdownType: 'device_platform', description: 'Mobile / Desktop' },
  { key: 'age', label: 'Age', breakdownType: 'age', description: 'Reported age range' },
  { key: 'gender', label: 'Gender', breakdownType: 'gender', description: 'Reported gender' },
  { key: 'region', label: 'Region', breakdownType: 'region', description: 'Geographic region' },
]

export const DIMENSION_BY_KEY: Record<string, DimensionDef> =
  Object.fromEntries(SEGMENT_DIMENSIONS.map((d) => [d.key, d]))

export function breakdownTypeFor(key: string): string | null {
  return DIMENSION_BY_KEY[key]?.breakdownType ?? null
}

// Metrics that the breakdown data actually supports (no reach / frequency / video at the segment level).
export const SEGMENT_METRIC_KEYS = [
  'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'leads', 'cpl', 'bookings', 'cpa',
] as const

// Tidy a raw breakdown_value for display (e.g. "audience_network" → "Audience network", "25-34" → "25-34").
export function prettifySegmentValue(value: string): string {
  if (!value || value === 'unknown') return 'Unknown'
  const spaced = value.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
