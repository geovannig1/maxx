import 'server-only'
import { createHash } from 'node:crypto'
import type { OutcomeSourceAdapter } from '@/lib/outcomes/adapter'
import { verifyAcuitySignature } from './webhook'
import { evaluateAcuityLedgerHealth, requireAcuityLedgerHealth } from './ledger-health'
import { ACUITY_LEDGER_HEALTH_KEY } from './ledger-health-key'
import { reconcileAcuityLedger } from './reconcile'
import { resolveSendMode } from '@/lib/capi/acuity-capi'

/**
 * The Acuity Scheduling example adapter (ADR-058), off unless ACUITY_USER_ID and ACUITY_API_KEY are
 * set. Reached through the registry: the webhook route checks its configuration and signatures with
 * validateConfig and verifyPush, and the daily sync runs the nightly reconcile and conversion sweep
 * through reconcile. The route's ledger writer and the adapter's own conversion sender stay its own:
 * the golden semantics (tests/golden) pin that sender's event, and the ledger rows carry Acuity's raw
 * appointment, which the core's normalized-outcome writer does not.
 *
 * Conversions: Acuity's own Meta integration already sends Purchase and Schedule without event ids, so
 * mirroring either would double-count. Maxx sends only its historical `AppointmentConfirmed` with the
 * deterministic `acuity-<id>` event id, which deduplicates against the pixel copy.
 */
export const acuityAdapter: OutcomeSourceAdapter = {
  kind: 'acuity',
  capabilities: {
    pull: true,
    push: true,
    backfill: true,
    carriesToken: true,
    originKnown: true,
    collectedValue: true,
    platformNativeEvents: ['Purchase', 'Schedule'],
    analyticsEventCarriesExternalId: true,
    conversionEventNames: { booking: 'AppointmentConfirmed' },
    ownConversionSender: true,
    derivedEventIdPrefix: 'acuity-',
  },
  validateConfig(env) {
    return env.ACUITY_USER_ID && env.ACUITY_API_KEY
      ? { ok: true, value: undefined }
      : { ok: false, reason: 'ACUITY_USER_ID and ACUITY_API_KEY are required' }
  },
  verifyPush({ rawBody, headers, secret }) {
    const signature = headers.get('x-acuity-signature')
    if (!signature) return { ok: false, reason: 'missing' }
    if (!verifyAcuitySignature(rawBody, signature, secret)) return { ok: false, reason: 'mismatch' }
    // Acuity signs no timestamp, so its deliveries cannot be replay-keyed; the route re-fetches by id.
    return { ok: true, deliveryKey: createHash('sha256').update(rawBody, 'utf8').digest('hex') }
  },
  async ledgerHealth(db, adAccountId, startDate, endDate, nowMs) {
    const status = await requireAcuityLedgerHealth(db, adAccountId, startDate, endDate, nowMs)
    return { lastReconciledAt: status.lastReconciledAt, windowEndDate: status.windowEndDate }
  },
  /** The nightly reconcile, then the ledger-health head the readers' completeness gate checks. A
   *  failed head write is reported in `warnings`, never as an unavailable reconciliation. */
  async reconcile({ supabase, adAccountId }) {
    const result = await reconcileAcuityLedger({ supabase, adAccountId })
    if (!result.available) return result
    const { error } = await supabase.from('app_settings').upsert(
      {
        ad_account_id: adAccountId,
        key: ACUITY_LEDGER_HEALTH_KEY,
        value: JSON.stringify({
          last_reconciled_at: result.completedAt,
          window_basis: result.sourceWindowBasis,
          window_start_date: result.windowStartDate,
          window_end_date: result.windowEndDate,
          fetched: result.fetched,
          upserted: result.upserted,
          webhook_misses: result.webhookMisses,
          truncated: result.truncated ?? false,
          capi_mode: result.capi?.mode ?? 'off',
          capi_sent: result.capi?.sent ?? 0,
          capi_errors: result.capi?.errors ?? 0,
          capi_marked_missed: result.capi?.markedMissed ?? 0,
        }),
        setting_type: 'json',
        label: 'Acuity Ledger Health',
        description: 'Latest Acuity ledger reconciliation + webhook-liveness snapshot',
      },
      { onConflict: 'ad_account_id,key' },
    )
    return error ? { ...result, warnings: [`ledger health: ${error.message}`] } : result
  },
  // Before the v1 release the shared vocabulary used this adapter's name: claim system 'acuity', evidence plane
  // 'acuity_business', metric keys 'acuity.*', report keys `acuity` / `acuityRecordedRevenue`, blocker
  // codes 'acuity_*' (qualified 'acuity:<code>') and business entity ids 'acuity-type:' / 'acuity-name:'.
  legacyVocabulary: {
    exact: {
      acuity: 'outcomes',
      acuityRecordedRevenue: 'recordedOutcomeValue',
      acuityRecordedAmountPaid: 'observedCollectedValue',
      acuityRecordedAmountPaid30: 'observedCollectedValue30',
      todayAcuityRecordedRevenue: 'todayRecordedOutcomeValue',
      todayAcuityRecordedAmountPaid: 'todayObservedCollectedValue',
    },
    // `report:acuity:` is the legacy claim-id prefix (`report:${source}:…`).
    prefixes: [['report:acuity:', 'report:outcomes:'], ['acuity-type:', 'outcome-type:'], ['acuity-name:', 'outcome-label:'], ['acuity_', 'outcome_'], ['acuity.', 'outcomes.']],
    qualifiers: [['acuity:', 'outcomes:']],
    identifierWord: ['Acuity', 'Outcome'],
  },
  conversionSendMode(env) {
    return resolveSendMode(env)
  },
  storedLedgerHealth: {
    settingKey: ACUITY_LEDGER_HEALTH_KEY,
    evaluate(raw, startDate, endDate, nowMs) {
      const status = evaluateAcuityLedgerHealth(raw, startDate, endDate, nowMs)
      return { available: status.available, reason: status.reason, lastReconciledAt: status.lastReconciledAt }
    },
  },
  async health(env = process.env) {
    const configured = Boolean(env.ACUITY_USER_ID && env.ACUITY_API_KEY)
    return { configured, detail: configured ? 'Acuity credentials set.' : 'Acuity credentials not set; the example adapter is off.' }
  },
}
