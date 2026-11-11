import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest } from 'next/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { getAppointment } from '@/lib/outcomes/adapters/acuity/client'
import { toLedgerRow, upsertAppointments, resolveAdAccountId } from '@/lib/outcomes/adapters/acuity/ledger'
import { parseWebhookBody, isAppointmentAction } from '@/lib/outcomes/adapters/acuity/webhook'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import {
  linkAcuityPaidTouchWithFallback,
  paidTouchLinkConfig,
  type LinkedPaidTouchForCapi,
} from '@/lib/outcomes/adapters/acuity/paid-touch-link'
import { sendAcuityCapiEvent } from '@/lib/capi/acuity-capi'
import { findAcuitySourceId } from '@/lib/outcomes/adapters/acuity/outcome-source'
import { preAuthRateLimit } from '@/lib/security/preauth-limit'

function secretMatches(supplied: string | null, expected: string): boolean {
  if (!supplied) return false
  const a = createHash('sha256').update(supplied, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}
import {
  recordSignedAcuityEligibilityInput,
  recordSignedAcuityLinkEvaluation,
} from '@/lib/outcomes/adapters/acuity/paid-link-evaluation'

export const runtime = 'nodejs'

const MAX_ACUITY_WEBHOOK_BYTES = 64 * 1024
/** Per client address, per server instance, checked before body and signature work. */
const ACUITY_PRE_AUTH_LIMIT_PER_MINUTE = 300

type BoundedRawBody =
  | { rawBody: string }
  | { error: 'invalid_content_length' | 'too_large' | 'unreadable' }

async function readBoundedRawBody(req: Request): Promise<BoundedRawBody> {
  const declared = req.headers.get('content-length')
  if (declared != null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0) return { error: 'invalid_content_length' }
    if (size > MAX_ACUITY_WEBHOOK_BYTES) return { error: 'too_large' }
  }
  if (!req.body) return { rawBody: '' }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ACUITY_WEBHOOK_BYTES) {
        await reader.cancel('Acuity webhook body exceeds byte limit')
        return { error: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { error: 'unreadable' }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { rawBody: new TextDecoder().decode(bytes) }
}

// ACUITY WEBHOOK → the appointment ledger + SERVER-SIDE CAPI (owner-approved plan 2026-07-17).
//
// Ledger first (business truth), then — on the INITIAL `scheduled` only — one AppointmentConfirmed to
// Meta keyed `acuity-<id>`. This is the SOLE server-side sender; it dedups against the browser Meta Pixel
// tag (same `acuity-<id>` via the deterministic-event-id GTM edit). The public browser relay was REMOVED
// (2026-07-18) — this server copy no longer carries a relay-captured _fbp, but keeps hashed
// email/phone/name + server-reconstructed fbc. Gated off→test→live by ACUITY_CAPI_SEND (deploy ≠
// activation); when the browser is blocked, this server copy is the only one Meta gets — 100% coverage.
// Reschedules/changes/cancels NEVER send (same event_id past the 48h dedup window would double-count,
// and Meta cannot retract). Delivery is at-least-once: a Meta failure records capi_send_error and the
// nightly sweep retries within the dedup-safe window; ledger consistency always wins (ACK 200).
//
// Security: Acuity signs each delivery HMAC-SHA256(base64) over the raw body under the API key
// (x-acuity-signature). We verify that (required). If ACUITY_WEBHOOK_SECRET is set we ALSO require a
// matching ?secret= (defense in depth / easy rotation). Acuity's webhook settings take only a URL (no
// custom header), so the secret travels in the query string and can appear in proxy/platform access
// logs; rotate it if those logs leak. Acuity's signature carries no timestamp, so a captured signed
// body can be replayed at any time: a replay only re-fetches the appointment's CURRENT state from the
// Acuity API and upserts it, and never sends a second Conversions API event (capi_sent_at). Inert
// (503) until ACUITY_USER_ID+API_KEY set.
//
// Idempotent: ledger upsert on appointment id; CAPI send skipped when capi_sent_at is already set
// (Acuity retries + the sweep converge), and Meta's event_id dedup backstops any overlap.

export async function POST(req: NextRequest) {
  // Configuration and signature checks go through the outcome-source adapter registry (the adapter
  // object's validateConfig and verifyPush); the ingestion below stays this adapter's own path.
  const adapter = getOutcomeAdapter('acuity')
  const acuityKey = process.env.ACUITY_API_KEY
  if (!adapter?.verifyPush || !acuityKey || !adapter.validateConfig(process.env, {}).ok) {
    return Response.json({ error: 'Webhook not configured (ACUITY_USER_ID / ACUITY_API_KEY missing).' }, { status: 503 })
  }

  // Before reading the body or any HMAC: an unauthenticated flood from one address costs nothing more.
  const preAuth = preAuthRateLimit(req, 'acuity-webhook', ACUITY_PRE_AUTH_LIMIT_PER_MINUTE)
  if (preAuth) return preAuth

  // Read the RAW body first — HMAC is over the exact bytes, and reading it also lets us parse the form.
  // Keep the stream bounded before signature work so unsigned public requests cannot force unbounded buffering.
  const body = await readBoundedRawBody(req)
  if ('error' in body) {
    if (body.error === 'too_large') return Response.json({ error: 'Webhook body too large' }, { status: 413 })
    return Response.json({ error: body.error === 'unreadable' ? 'Unreadable body' : 'Invalid Content-Length' }, { status: 400 })
  }
  const { rawBody } = body

  if (!adapter.verifyPush({ rawBody, headers: req.headers, url: new URL(req.url), secret: acuityKey }).ok) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 })
  }
  const webhookSecret = process.env.ACUITY_WEBHOOK_SECRET
  if (webhookSecret && !secretMatches(req.nextUrl.searchParams.get('secret'), webhookSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { action, id } = parseWebhookBody(rawBody)
  if (!id) return Response.json({ error: 'Missing appointment id' }, { status: 400 })
  if (!isAppointmentAction(action)) {
    // e.g. order.completed (packages/gift certs) — acknowledged so Acuity stops retrying; not a booking.
    return Response.json({ ok: true, skipped: action || 'unknown-action' })
  }

  // Fetch current appointment state and upsert. Meta is intentionally untouched.
  let appt
  try {
    appt = await getAppointment(id)
  } catch (err) {
    console.error('[Acuity webhook] fetch failed:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'Acuity fetch failed' }, { status: 502 }) // 5xx → Acuity retries
  }
  if (!appt) return Response.json({ ok: true, skipped: 'appointment-not-found', id })

  const db = getAdminClient()
  let adAccountId: string | null = null
  try {
    adAccountId = await resolveAdAccountId(db)
    await upsertAppointments([toLedgerRow(appt, adAccountId, 'webhook')])
  } catch (err) {
    console.error('[Acuity webhook] ledger upsert failed:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'Ledger upsert failed' }, { status: 502 })
  }

  // Attribution is linked only after the signed by-id appointment is durable. A missing token falls
  // back to fbclid matching when the intake carries paid-social attribution; a rejected token never
  // blocks the business ledger or conversion; it simply cannot contribute paid-touch identity or fbc.
  // Audit persistence failures are deferred until after the immediate CAPI path has run. We still
  // return 5xx so Acuity retries the missing evidence, while deterministic event_id delivery state
  // prevents a retry from sending the conversion twice.
  if (!adAccountId) {
    return Response.json({ error: 'Paid eligibility account unavailable' }, { status: 502 })
  }
  let linkedPaidTouch: LinkedPaidTouchForCapi | null = null
  const linkConfig = paidTouchLinkConfig()
  let auditFailure: 'Paid eligibility input write failed' | 'Paid-link evaluation write failed' | null = null
  let eligibilityInput: Awaited<ReturnType<typeof recordSignedAcuityEligibilityInput>> | null = null
  try {
    eligibilityInput = await recordSignedAcuityEligibilityInput(db, adAccountId, appt, linkConfig)
  } catch (err) {
    console.error('[Acuity webhook] paid eligibility input write failed:', err instanceof Error ? err.message : err)
    auditFailure = 'Paid eligibility input write failed'
  }
  let linkOutcome: Awaited<ReturnType<typeof linkAcuityPaidTouchWithFallback>>
    | { status: 'not_configured' }
    | { status: 'error'; reason: 'link_exception' } = {
    status: 'not_configured',
  }
  if (linkConfig) {
    try {
      const linked = await linkAcuityPaidTouchWithFallback(db, adAccountId, appt, linkConfig)
      linkOutcome = linked
      if (linked.status === 'linked') linkedPaidTouch = linked.paidTouch
      else if (linked.status !== 'absent') {
        console.error('[Acuity webhook] paid-touch link rejected', { reason: linked.reason })
      }
    } catch {
      console.error('[Acuity webhook] paid-touch link failed')
      linkOutcome = { status: 'error', reason: 'link_exception' }
    }
  }

  // The signed webhook is the independent linker input set. Persist every evaluation—including
  // absence, rejection, configuration gaps, and errors—or return 5xx so Acuity retries. A successful
  // link can never be its own completeness denominator.
  if (eligibilityInput) {
    try {
      await recordSignedAcuityLinkEvaluation(
        db, adAccountId, appt, linkOutcome, linkConfig, eligibilityInput,
      )
    } catch (err) {
      console.error('[Acuity webhook] paid-link evaluation write failed:', err instanceof Error ? err.message : err)
      auditFailure = 'Paid-link evaluation write failed'
    }
  }

  // ── Server-side CAPI (initial `scheduled` only; ledger already durable — failures never 5xx). ──
  let capi: string = 'not-applicable'
  const isInitialScheduled = /scheduled$/i.test(action) && !/rescheduled$/i.test(action)
  if (isInitialScheduled && appt.canceled !== true) {
    try {
      // The outcome row this webhook just upserted: (account, its Acuity source, external id).
      const sourceId = await findAcuitySourceId(db, adAccountId)
      let row: { id: string; conversion_sent_at: string | null; fbp: string | null } | null = null
      if (sourceId) {
        const { data } = await db
          .from('outcomes')
          .select('id, conversion_sent_at, fbp')
          .eq('ad_account_id', adAccountId)
          .eq('source_id', sourceId)
          .eq('external_id', String(Number(appt.id)))
          .maybeSingle()
        row = data
      }
      if (row?.conversion_sent_at) {
        capi = 'already-delivered'
      } else {
        // The public browser relay was removed (2026-07-18): _fbp is no longer captured, so there is no
        // writer to wait for — the 2.5s grace re-read is gone. Send with whatever the ledger row holds
        // (fbp is optional to the sender; it is now normally null for browser bookings). fbc is NOT
        // rebuilt from the booking's intake fbclid — that value carries no proven click time (ADR-056
        // §5). It comes only from the linked paid touch below, or it is omitted.
        const fbp = (row?.fbp as string | null) ?? null
        const outcome = await sendAcuityCapiEvent(appt, fbp, db, linkedPaidTouch)
        capi = outcome.status === 'sent' ? `sent-${outcome.mode}` : outcome.status === 'skipped' ? `skipped-${outcome.skip}` : outcome.status
        // conversion_sent_at is stamped INSIDE record_conversion_delivery, in the same
        // transaction as the delivery lineage row, and only for a live Meta-accepted send (R2). This
        // route no longer stamps it: a second writer is how "delivered" drifted from reality.
        if (outcome.status === 'accepted_unrecorded') {
          // CRITICAL: Meta has the event, the audit row does not exist. Left unsent on purpose so the
          // sweep retries; the deterministic event_id makes the retry dedup-safe.
          console.error(`[Acuity webhook] CAPI accepted but unrecorded for ${outcome.eventId} — sweep will retry`)
        } else if (outcome.status === 'skipped' && outcome.skip && row) {
          const { error: upErr } = await db.from('outcomes').update({ conversion_send_error: outcome.skip }).eq('id', row.id)
          if (upErr) console.error('[Acuity webhook] skip-label write failed:', upErr.message)
        } else if (outcome.status === 'error' && outcome.error && row) {
          // Recorded for visibility; the nightly sweep retries within the 46h dedup-safe window.
          const { error: upErr } = await db.from('outcomes').update({ conversion_send_error: outcome.error.slice(0, 300) }).eq('id', row.id)
          if (upErr) console.error('[Acuity webhook] error-label write failed:', upErr.message)
        }
      }
    } catch (err) {
      console.error('[Acuity webhook] CAPI step failed:', err instanceof Error ? err.message : err)
      capi = 'error'
    }
  }

  if (auditFailure) return Response.json({ error: auditFailure }, { status: 502 })

  return Response.json({ ok: true, action, id, canceled: appt.canceled === true, capi })
}
