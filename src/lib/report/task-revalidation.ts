import { getAdminClient } from '@/lib/supabase/admin'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { getGa4ConfirmationTelemetryByCampaign } from '@/lib/ga4/client'
import { projectCurrentActionableTasks } from '@/lib/authority/diagnostic-surface'
import { formatMoney } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

// TASK LIFECYCLE — positive-invalidation-only re-validation (default KEEP).
//
// The report generator writes tasks only from current governed ActionDecisions. Historical task rows are
// immutable audit records and are excluded before this lifecycle runs. An age-based purge is wrong — it
// would also kill still-valid current work.
//
// So this closes a task ONLY when current reality POSITIVELY PROVES its premise false. A task whose
// premise we cannot disprove is always KEPT. The genuine conversion-value task matches none of the
// invalidation rules (spend>0 / active campaigns / pixel firing don't prove the value is set), so it
// survives by construction.

export interface TaskLike {
  id: string
  title: string
  description: string | null
  recommendation: string | null
}

/** Normalized dedup key: strip the "**PRIORITY:" prefix + markdown, lowercase, collapse to a prefix —
 *  so the same instruction re-authored by the LLM on different days doesn't create duplicate tasks. */
export function taskDedupKey(title: string): string {
  // FULL normalized string, digits stripped — NOT a prefix. (A 60-char prefix collided two
  // genuinely different instructions sharing boilerplate openings, silently dropping the newer one.
  // Digits are stripped because the LLM re-authors the same instruction with tweaked numbers — "$265" vs
  // "$250" — which must still dedup as one instruction.)
  return title
    .replace(/\*\*/g, '')
    .replace(/^\s*(urgent|high|medium|low|critical|p[0-9])\s*:\s*/i, '')
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Current-reality signals used to disprove a stale premise. */
export interface AccountReality {
  /** Σ account spend, last 7 days. */
  spend7d: number
  /** ≥1 active campaign exists (delivery is happening / has happened recently). */
  hasActiveDelivery: boolean
  /** AppointmentConfirmed events (Meta-attributed) in the last 7 days. */
  appointmentEvents7d: number
  /** GA confirmation EVENTS on paid campaigns. Not bookings — no appointment identity. */
  paidConfirmationEvents30d: number
  /** Paid-attribution health (named paid ÷ all paid), or null when unknown. */
  attributedShare: number | null
}

/** Returns a human reason string ONLY when the task's premise is provably false; else null (KEEP).
 *
 *  Hardened: the reality signals are ACCOUNT-level, so any task that scopes itself
 *  to a specific entity, proposes NEW/additional work, or is a hold/negation directive is out of the
 *  rules' jurisdiction — the shared guard KEEPs those before any rule runs. False-KEEP (a stale task
 *  lingers) is the safe failure direction; false-CLOSE silently dismisses real work. */
export function revalidateTask(task: TaskLike, reality: AccountReality): string | null {
  const text = `${task.title} ${task.description ?? ''} ${task.recommendation ?? ''}`.toLowerCase()

  // Shared guard — cues that the premise is scoped, additive, or a hold directive. Account-level signals
  // cannot disprove these; default KEEP.
  if (
    /\bdo not\b|\bdon'?t\b|hold off|wait until|\buntil\b|once .{0,40}(then|clears|holds)|\bnew \b|additional|another|complement|expand(ing)? (to|into|the)|second (campaign|ad set)|this (specific )?(ad set|ad|campaign) (has|is|isn)|the [a-z0-9 %|]+ ad set (has|is|isn)/.test(text)
  ) {
    return null
  }

  // Premise: ACCOUNT not spending / paused / billing failure. (Bare "$0.00"/"toggled on"
  // removed — they match per-line-item zeros and routine phrasing; only account-scoped forms remain.)
  if (
    /zero impressions across|spending \$0|amount spent is \$0|account is spending \$0|billing (failure|status)|why (all |the )?(campaigns|account).*(paused|inactive|spend)/.test(text) &&
    reality.spend7d > 0
  ) {
    return `Account is delivering — ${formatMoney(reality.spend7d, { maximumFractionDigits: 0 })} spent in the last 7 days; the "no/zero spend / paused account" premise is false.`
  }

  // Premise: no active campaigns at all / "launch the first campaigns" / relaunch-from-dormancy plan.
  // Reactivation verbs are covered; the shared guard above already KEEPs "launch a NEW/…" tasks.
  if (
    /(launch|build and launch|relaunch|reactivate|resume|restart|draft a campaign relaunch).*(campaign|cold|professional|consumer|audience)|no active campaign|zero.*paid presence|there are no active/.test(text) &&
    reality.hasActiveDelivery
  ) {
    return `Active delivering campaigns exist now; the "no active campaigns / zero paid presence / needs launch" premise is false.`
  }

  // Premise: AppointmentConfirmed / the booking pixel not firing. Scoped to the ONE event the signal can
  // disprove — a task about AddToCart/ViewContent/Lead verification is out of jurisdiction.
  if (
    /appointmentconfirmed|booking pixel|custom event code/.test(text) &&
    /not firing|stopped firing|zero appointmentconfirmed|0 events|is (the )?(pixel|event) (firing|broken)|verify.*(firing|fires)|audit.*(pixel|firing)|pixel.*(broken|resumes)/.test(text) &&
    reality.appointmentEvents7d > 0
  ) {
    return `${EVENT} is firing — ${reality.appointmentEvents7d} in the last 7 days; the "pixel not firing / 0 events" premise is false.`
  }

  // Premise: attribution broken account-wide / "0 paid bookings" / UTMs not passing through.
  if (
    /attribution (is )?(broken|firing correctly)|0 paid bookings|zero paid bookings|no paid bookings in|ga4 (shows|paid).*(0|\$0)|utm.*(broken|aren.t passing|not persisting)|every future paid booking will appear as organic/.test(text) &&
    (reality.paidConfirmationEvents30d > 0 || (reality.attributedShare != null && reality.attributedShare >= 0.5))
  ) {
    const share = reality.attributedShare != null ? `, ${Math.round(reality.attributedShare * 100)}% of confirmation events campaign-tagged` : ''
    return `Paid attribution is working — ${reality.paidConfirmationEvents30d} paid confirmation event(s) in 30d${share}; the "attribution broken / 0 paid events" premise is false. (Confirmation events are telemetry, not ${OW.many}.)`
  }

  return null // default KEEP — premise not disproven
}

/** PURE: ids to dismiss as duplicates — keeps the FIRST occurrence per dedup key (pass tasks oldest-first
 *  so the original survives), returns the rest. Cleans dups created BEFORE generation-time dedup existed. */
export function findDuplicateTaskIds(tasks: { id: string; title: string }[]): string[] {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const t of tasks) {
    const k = taskDedupKey(t.title)
    if (seen.has(k)) dups.push(t.id)
    else seen.add(k)
  }
  return dups
}

export interface Invalidation {
  id: string
  reason: string
}

/** PURE: the tasks whose premise current reality positively disproves. */
export function revalidateTasks(tasks: TaskLike[], reality: AccountReality): Invalidation[] {
  const out: Invalidation[] = []
  for (const t of tasks) {
    const reason = revalidateTask(t, reality)
    if (reason) out.push({ id: t.id, reason })
  }
  return out
}

/** IMPURE: gather reality, close positively-invalidated open tasks (status=dismissed, auditable note).
 *  Returns the count auto-closed. Non-fatal by contract — callers treat a throw as a partial error. */
export async function runTaskRevalidation(adAccountDbId: string): Promise<number> {
  const db = getAdminClient()
  const since7 = nyDaysAgo(7)
  const yday = nyDaysAgo(1)

  const [tasksRes, spendRes, activeCampRes, ga4] = await Promise.all([
    db.from('audit_tasks').select('id, title, description, recommendation, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)').eq('ad_account_id', adAccountDbId).in('status', ['open', 'in_progress']),
    db.from('daily_insights').select('spend, bookings').eq('ad_account_id', adAccountDbId).eq('entity_level', 'account').gte('date_start', since7),
    // MUST be scoped to this account — an unscoped count made hasActiveDelivery true
    // whenever ANY account had an active campaign, systematically auto-closing a dormant account's
    // genuine "launch your first campaign" tasks.
    db.from('campaigns').select('id', { count: 'exact', head: true }).eq('ad_account_id', adAccountDbId).eq('effective_status', 'ACTIVE'),
    getGa4ConfirmationTelemetryByCampaign(nyDaysAgo(30), yday).catch(() => null),
  ])

  const tasks = projectCurrentActionableTasks(
    (tasksRes.data ?? []) as Array<Record<string, unknown>>,
  ) as unknown as TaskLike[]
  if (tasks.length === 0) return 0

  const spendRows = (spendRes.data ?? []) as { spend: number | null; bookings: number | null }[]
  const reality: AccountReality = {
    spend7d: spendRows.reduce((s, r) => s + Number(r.spend ?? 0), 0),
    appointmentEvents7d: spendRows.reduce((s, r) => s + Number(r.bookings ?? 0), 0),
    hasActiveDelivery: (activeCampRes.count ?? 0) > 0,
    paidConfirmationEvents30d: ga4 && ga4.available ? ga4.rows.reduce((s, r) => s + r.confirmationEvents, 0) : 0,
    attributedShare: ga4 && ga4.available ? ga4.attributedShare : null,
  }

  const closeOne = async (id: string, note: string) => {
    const { error } = await db
      .from('audit_tasks')
      .update({
        status: 'dismissed',
        completion_note: note,
        completed_by: 'system:revalidation',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('ad_account_id', adAccountDbId)
    if (error) throw new Error(`runTaskRevalidation update failed: ${error.message}`)
  }

  // (1) Positive-invalidation: close tasks whose premise reality disproves.
  const toClose = revalidateTasks(tasks, reality)
  for (const inv of toClose) await closeOne(inv.id, `Auto-closed by re-validation: ${inv.reason}`)

  // (2) Retroactive dedup: collapse duplicate open tasks created before generation-time dedup existed.
  //     Reload (excluding the just-closed) ordered oldest-first so the original is the survivor.
  const closedIds = new Set(toClose.map((c) => c.id))
  const remaining = tasks.filter((t) => !closedIds.has(t.id))
  if (remaining.length === 0) return toClose.length
  const { data: ordered } = await db
    .from('audit_tasks')
    .select('id, title')
    .eq('ad_account_id', adAccountDbId)
    .in('id', remaining.map((t) => t.id))
    .order('created_at', { ascending: true })
  const dupIds = findDuplicateTaskIds((ordered ?? []) as { id: string; title: string }[])
  for (const id of dupIds) await closeOne(id, 'Auto-closed: duplicate of an existing open task.')

  return toClose.length + dupIds.length
}
