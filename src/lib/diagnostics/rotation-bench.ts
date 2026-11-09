// ROTATION BENCH. Paused creatives accumulate with no rotation planned, and nothing reports
// what is actually available to rotate TO.
//
// The discipline this module exists to keep: "you have 20 unused creatives" is noise on its own.
// For example, when peak frequency across every ACTIVE ad sits well below the fatigue thresholds,
// rotation is NOT indicated and the bench is simply inventory. Reporting an
// unused bench as if it were an outstanding action would manufacture urgency that the delivery data
// does not support.
//
// The two tiers are not interchangeable:
//   • proven   — has delivered AND produced attributed results. Known to work; the safe draw.
//                (e.g. the ad with the highest lifetime attributed count in an account, paused
//                 for months.)
//   • untested — created and never delivered. Real inventory, unknown quality.
//                (e.g. a relaunched copy of a proven ad that never delivered.)
//
// Observation only. The fatigue → rotate decision is governed elsewhere; this never prescribes.

export interface BenchAd {
  name: string
  status: string
  ever_delivered: boolean
  lifetime_spend: number | null
  attributed_results: number | null
  days_since_delivery: number | null
}

export interface RotationBenchResult {
  active_count: number
  /** Benched ads that have delivered AND produced at least one attributed result. */
  proven_reserve: BenchAd[]
  /** Benched ads that have never delivered. */
  untested_reserve: BenchAd[]
  /** Null when frequency is unknown — never guessed in either direction. */
  rotation_indicated: boolean | null
  detail: string
  action_authority: 'diagnostic_only'
  prescriptions: readonly []
}

export interface RotationFatigueEvidence {
  /** Corroborated fatigue verdict from a governed trend/test surface. Frequency alone is insufficient. */
  observed: boolean | null
  basis: string
}

export function assessRotationBench(args: {
  ads: BenchAd[]
  peakFrequency: number | null
  fatigueEvidence?: RotationFatigueEvidence | null
}): RotationBenchResult {
  const { ads, peakFrequency, fatigueEvidence } = args
  const active = ads.filter((a) => a.status === 'ACTIVE')
  const benched = ads.filter((a) => a.status !== 'ACTIVE')

  const proven_reserve = benched.filter((a) => a.ever_delivered && (a.attributed_results ?? 0) > 0)
  const untested_reserve = benched.filter((a) => !a.ever_delivered)

  const base = {
    active_count: active.length,
    proven_reserve,
    untested_reserve,
    action_authority: 'diagnostic_only' as const,
    prescriptions: [] as const,
  }

  const inventory =
    proven_reserve.length === 0 && untested_reserve.length === 0
      ? 'The bench is empty — no reserve creative exists'
      : `Bench: ${proven_reserve.length} proven reserve (has delivered and produced attributed results), ` +
        `${untested_reserve.length} untested reserve (created, never delivered)`

  const frequencyNote = peakFrequency == null
    ? 'No peak-frequency reading is available.'
    : `Observed peak frequency is ${peakFrequency.toFixed(2)}.`

  if (!fatigueEvidence || fatigueEvidence.observed == null) {
    return {
      ...base,
      rotation_indicated: null,
      detail:
        `${inventory}. Whether rotation is indicated is unknown. ${frequencyNote} Frequency alone cannot establish ` +
        'creative fatigue; corroborating trend or predeclared test evidence is unavailable.',
    }
  }

  if (!fatigueEvidence.observed) {
    return {
      ...base,
      rotation_indicated: false,
      detail:
        `${inventory}. Rotation is NOT indicated by the supplied fatigue evidence: ${fatigueEvidence.basis} ` +
        `${frequencyNote} The bench is inventory, not an outstanding action.`,
    }
  }

  const exposure =
    proven_reserve.length === 0 && untested_reserve.length === 0
      ? ' Nothing is available to rotate to — fatigue with an empty bench is the real exposure here.'
      : ''

  return {
    ...base,
    rotation_indicated: true,
    detail:
      `${inventory}. Corroborated fatigue evidence indicates rotation: ${fatigueEvidence.basis} ` +
      `${frequencyNote}${exposure}`,
  }
}
