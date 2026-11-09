// Creative evidence for the owner-facing Ad Performance surface. This module deliberately describes
// Meta delivery and attention telemetry only. It does not evaluate business outcomes and cannot emit
// a decision; governed decisions live in the current recommendation authority pipeline.

import type { EarlyViewSource } from './video-metrics'

export type CreativeSignalState = 'observed' | 'partial' | 'unavailable'

export interface CreativeDiagnosticSignal {
  label: string
  state: CreativeSignalState
  detail: string
}

export interface CreativeDiagnosticInput {
  /** Meta click-through rate as a percentage. */
  ctr: number | null
  /** Meta average frequency for the selected window. */
  frequency: number | null
  /** Video starts (or continuous two-second views) divided by impressions. */
  earlyViewRate: number | null
  earlyViewSource: EarlyViewSource
  /** Meta ThruPlays divided by impressions. */
  thruplayRate: number | null
  /** Share reaching one quarter of video length. */
  retentionP25Rate: number | null
  retentionDenominator: 'video_starts' | 'impressions'
  videoStartCoverage: 'complete' | 'partial' | 'unavailable'
  derivedMetricWarningCount: number
  impressions: number
  windowDays: number
}

export interface CreativeDiagnostic {
  authority: 'diagnostic_only'
  state: 'evidence_available' | 'insufficient_data'
  label: 'Delivery evidence' | 'Limited delivery evidence'
  reason: string
  prescriptions: []
  signals: CreativeDiagnosticSignal[]
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

function observedPercent(
  label: string,
  value: number | null,
  detail: (formatted: string) => string,
  partial = false,
): CreativeDiagnosticSignal {
  if (value === null || !Number.isFinite(value)) {
    return { label, state: 'unavailable', detail: `${label} is unavailable for this window.` }
  }
  return {
    label,
    state: partial ? 'partial' : 'observed',
    detail: detail(percent(value)),
  }
}

/** PURE: report delivery/attention evidence without translating it into a creative or money action. */
export function getCreativeDiagnostic(input: CreativeDiagnosticInput): CreativeDiagnostic {
  const ctrPartial = input.impressions > 0 && input.impressions < 500
  const frequencyPartial = input.windowDays > 0 && input.windowDays < 3
  const retentionPartial = input.videoStartCoverage !== 'complete' || input.retentionDenominator !== 'video_starts'

  const earlyViewSignal = input.earlyViewSource === 'unavailable'
    ? {
        label: 'Early-view rate',
        state: 'unavailable' as const,
        detail: 'Early-view rate is unavailable because Meta returned neither video starts nor continuous two-second views.',
      }
    : observedPercent(
        'Early-view rate',
        input.earlyViewRate,
        (value) => `${value} from ${input.earlyViewSource === 'video_play_actions' ? 'video starts' : 'continuous two-second views'} divided by impressions.`,
      )

  const signals: CreativeDiagnosticSignal[] = [
    observedPercent(
      'CTR',
      input.ctr,
      (value) => ctrPartial
        ? `${value} from ${input.impressions.toLocaleString()} impressions; the sample is descriptive only.`
        : `${value} from Meta clicks divided by impressions.`,
      ctrPartial,
    ),
    input.frequency === null || !Number.isFinite(input.frequency)
      ? { label: 'Frequency', state: 'unavailable', detail: 'Frequency is unavailable for this window.' }
      : {
          label: 'Frequency',
          state: frequencyPartial ? 'partial' : 'observed',
          detail: frequencyPartial
            ? `${input.frequency.toFixed(2)} over ${input.windowDays} day(s); the short window is descriptive only.`
            : `${input.frequency.toFixed(2)} average Meta frequency over ${input.windowDays} day(s).`,
        },
    earlyViewSignal,
    observedPercent(
      'ThruPlay rate',
      input.thruplayRate,
      (value) => `${value} from Meta ThruPlays divided by impressions.`,
    ),
    observedPercent(
      '25% retention',
      input.retentionP25Rate,
      (value) => retentionPartial
        ? `${value}; video-start coverage or denominator is incomplete, so treat this as partial.`
        : `${value} of measured video starts reached one quarter of video length.`,
      retentionPartial,
    ),
  ]

  if (input.derivedMetricWarningCount > 0) {
    signals.push({
      label: 'Derived-metric integrity',
      state: 'partial',
      detail: `${input.derivedMetricWarningCount} derivation warning(s) were recorded for this window.`,
    })
  }

  const hasEvidence = signals.some((signal) => signal.state !== 'unavailable')
  return {
    authority: 'diagnostic_only',
    state: hasEvidence ? 'evidence_available' : 'insufficient_data',
    label: hasEvidence ? 'Delivery evidence' : 'Limited delivery evidence',
    reason: hasEvidence
      ? 'Meta delivery and attention evidence is available. Business outcome authority is not evaluated on this surface.'
      : 'No usable Meta delivery or attention evidence is available for this window.',
    prescriptions: [],
    signals,
  }
}
