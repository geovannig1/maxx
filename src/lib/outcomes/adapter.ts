import type { SupabaseClient } from '@supabase/supabase-js'
import type { OutcomeOrigin, OutcomeStatus, OutcomeType } from './model'
import type { SourceReconcileResult, StoredLedgerHealthStatus } from './reconciliation'
import type { LegacyVocabulary } from './legacy-vocabulary'

/**
 * The outcome-source adapter contract (ADR-058 "Source adapters"). An adapter knows one system's
 * transport and payload shape and normalizes it into a NormalizedOutcome. The core, not adapters, owns
 * the upsert, observations, touch linking, conversions eligibility and ledger health.
 */

/** Ad-platform standard event names an adapter may name in `platformNativeEvents`. */
export type ConversionEventName = 'Lead' | 'Purchase' | 'Schedule' | 'CompleteRegistration' | string

export interface OutcomeSourceCapabilities {
  /** The source can be read on demand (a sweep or reconciliation). */
  pull: boolean
  /** The source pushes outcomes to Maxx (a signed webhook). */
  push: boolean
  backfill: boolean
  /** The source can carry an attribution token (hidden form field, checkout metadata, CRM field). */
  carriesToken: boolean
  /** The source states whether an outcome came from the website. */
  originKnown: boolean
  collectedValue: boolean
  /**
   * Conversion events the business already sends to the ad platform for this source (its own pixel or
   * native integration). Maxx never mirrors these, so one result is never counted twice.
   */
  platformNativeEvents: readonly ConversionEventName[]
  /** The business website's analytics confirmation event carries this source's external id, so
   *  analytics events can be joined to outcomes by it (the GA4 reconciliation). */
  analyticsEventCarriesExternalId?: boolean
  /**
   * Per-type event-name overrides for this source. The reference adapter keeps its historical
   * `AppointmentConfirmed` so it still deduplicates against the existing pixel copy.
   */
  conversionEventNames?: Partial<Record<OutcomeType, ConversionEventName>>
  /** The adapter sends its own conversions (its own sender and send flag), so the generic outcome
   *  conversions sender never sends for this source. */
  ownConversionSender?: boolean
  /** The prefix of the conversion event id Maxx derives for this source's outcomes; a sender may never
   *  supply an id with it. */
  derivedEventIdPrefix?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string }

export type VerifyResult =
  | { ok: true; deliveryKey: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' | 'unconfigured' }

/** One result normalized from a source. Money is an exact decimal string; null means not observed. */
export interface NormalizedOutcome {
  externalId: string
  outcomeType: OutcomeType
  outcomeLabel: string | null
  status: OutcomeStatus
  currency: string
  grossValue: string | null
  collectedValue: string | null
  occurredAt: string
  fulfilmentAt: string | null
  fulfilmentStatus: 'scheduled' | 'fulfilled' | 'no_show' | null
  origin: OutcomeOrigin
  attribution: {
    fbclid: string | null
    fbc: string | null
    fbp: string | null
    gclid: string | null
    utmSource: string | null
    utmMedium: string | null
    utmCampaign: string | null
    utmContent: string | null
    utmTerm: string | null
    landingPage: string | null
    referrer: string | null
  }
  customer: {
    email: string | null
    phone: string | null
    firstName: string | null
    lastName: string | null
  }
  /** Sender-supplied conversion event id shared with its browser pixel (webhook only); null: derived. */
  conversionEventId?: string | null
  /** The sender's own version time; an older delivery than the stored one is not applied. */
  sourceUpdatedAt?: string | null
}

export interface PushEnvelope {
  outcome: NormalizedOutcome
  /** The signed paid-touch token the delivery carried (sources with `carriesToken`), never stored
   *  with the outcome; the core verifies it and links the outcome to its paid touch. */
  paidTouchToken?: string | null
}

export interface SourceHealth {
  configured: boolean
  detail: string
}

/** The window a reconciled source's stored outcomes are authoritative for. */
export interface SourceLedgerHealth {
  lastReconciledAt: string | null
  /** Last business date the source's reconciliation proved complete. */
  windowEndDate: string | null
}

export interface OutcomeSourceAdapter {
  kind: string
  capabilities: OutcomeSourceCapabilities
  validateConfig(env: Record<string, string | undefined>, config: Record<string, unknown>): Result<void>
  verifyPush?(req: { rawBody: string; headers: Headers; url: URL; secret: string; nowMs?: number }): VerifyResult
  parsePush?(rawBody: string): Result<PushEnvelope[]>
  fetchById?(externalId: string): Promise<NormalizedOutcome | null>
  health(env?: Record<string, string | undefined>): Promise<SourceHealth>
  /**
   * Completeness gate for a source Maxx reconciles against the source system: resolves only when the
   * stored outcomes are authoritative for the business-date window, and otherwise throws a reason
   * code. A push-only source has none; its outcomes count as received (src/lib/outcomes/source-health.ts).
   */
  ledgerHealth?(db: SupabaseClient, adAccountId: string, startDate: string, endDate: string, nowMs?: number): Promise<SourceLedgerHealth>
  /**
   * The scheduled reconciliation against the source system (pull, upsert, conversion retry sweep), run
   * by the daily lifecycle sync. The adapter records its own ledger-health head. An unconfigured
   * source resolves `{ available: false }`; it never throws for that.
   */
  reconcile?(opts: { supabase: SupabaseClient; adAccountId: string }): Promise<SourceReconcileResult>
  /** Names this source once lent to shared persisted vocabulary, upgraded when old documents are read. */
  legacyVocabulary?: LegacyVocabulary
  /** The mode of the adapter's own conversion sender (when `capabilities.ownConversionSender`). */
  conversionSendMode?(env: Record<string, string | undefined>): 'live' | 'test' | 'off'
  /** Where the adapter stores its ledger-health head and how to judge it, for read-only views. */
  storedLedgerHealth?: {
    settingKey: string
    evaluate(raw: unknown, startDate: string, endDate: string, nowMs: number): StoredLedgerHealthStatus
  }
}
