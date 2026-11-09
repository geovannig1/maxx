import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { isDemoMode } from '@/config/demo'
import { emitAlert } from '@/lib/monitoring/alerts'
import { normalizeMetaAccountId } from '@/lib/writes/meta-live-state'
import { campaignPlanSpecSchema, type CampaignPlanSpec } from './plan-spec'
import { loadPlanContext } from './plan-context'
import { evaluatePlan, hashSpec } from './plan-repository'
import {
  CreationStepError, createPlanObjects, createdByRequest, liveCreator, loadObjectRows, markerSeed, objectSummary, simulatedCreator, verifyPlanObjects,
  type CreationContext,
} from './plan-creation'
import {
  claim, dbError, finalize, isRequest, readRequest, recheckRequest, release, rollbackInFlight, ROLLBACK_PENDING, setVersionStatus,
  type PlanRequestRow,
} from './plan-execution-lock'

// ADR-062: applying an approved campaign-plan request. Gates, in order: write mode (or the demo's
// simulator), the request's account, status and expiry, the plan's integrity (its hash), a fresh
// re-validation against the account as it is now, and the per-account execution lock (the same
// action_log claim the ADR-059 executor uses). The request, the version and the object rows are read
// again AFTER the claim, so an attempt that waited behind a finished run stops (security review L1).
// Then every object is created PAUSED, read back, and the outcome recorded on the action_log row, the
// change request (compare-and-set) and the plan. A partial failure leaves a resumable request with
// cleanup guidance; nothing is ever activated.

type Db = ReturnType<typeof getAdminClient>
export const DEMO_PLAN_LABEL = 'Demo: simulated — campaign objects created in the sample data only, all paused; nothing was sent to Meta.'
const PARTIAL_GUIDANCE = 'Some objects were created, all PAUSED. Resume creates only the missing ones; Roll back archives the ones created. Nothing spends while paused.'

const writeModeOn = () => process.env.WRITE_MODE_ENABLED === 'true'

interface VersionRead { id: string; status: string; spec: CampaignPlanSpec }
const isVersion = (value: VersionRead | Record<string, unknown>): value is VersionRead => 'spec' in value && 'id' in value

/** The approved version, its integrity (the hash the owner approved) and a status that may run. */
async function readVersion(db: Db, request: PlanRequestRow, accountId: string): Promise<VersionRead | Record<string, unknown>> {
  const { data, error } = await db.from('campaign_plan_versions').select('id, status, spec, spec_hash')
    .eq('id', request.campaign_plan_version_id as string).eq('ad_account_id', accountId).maybeSingle()
  if (error || !data) return dbError('version read', error)
  const version = data as { id: string; status: string; spec: unknown; spec_hash: string }
  const parsed = campaignPlanSpecSchema.safeParse(version.spec)
  if (!parsed.success || hashSpec(parsed.data) !== version.spec_hash || request.params.spec_hash !== version.spec_hash || request.params.plan_version_id !== version.id) {
    return { status: 'INTEGRITY_MISMATCH', message: 'The approved plan does not match its recorded hash. Nothing was sent to Meta.' }
  }
  if (!['approved', 'failed', 'creating'].includes(version.status)) return { status: 'NOT_APPROVED', message: `The plan is ${version.status}.` }
  return { id: version.id, status: version.status, spec: parsed.data }
}

/** Apply one approved (or resume one failed) campaign-plan request. */
export async function executeCampaignPlanChange(changeRequestId: string, actor: string, accountId: string, options: { simulate?: boolean } = {}): Promise<Record<string, unknown>> {
  const simulate = isDemoMode()
  if (options.simulate && !simulate) return { status: 'ERROR', error: 'DEMO_ONLY', message: 'The simulated creation runs only in demo mode.' }
  if (!simulate && !writeModeOn()) {
    emitAlert({ area: 'write_attempt', severity: 'critical', dedupeKey: changeRequestId, message: `Campaign creation attempted while write mode is OFF (change_request ${changeRequestId}, actor ${actor}). Blocked; nothing was created.` })
    return { status: 'WRITE_MODE_DISABLED', message: 'Write mode is OFF (WRITE_MODE_ENABLED unset). Nothing was created in Meta.' }
  }
  const db = getAdminClient()
  const cr = await readRequest(db, changeRequestId, accountId)
  if (!isRequest(cr)) return cr
  const request = cr
  if (request.action_type === 'archive_campaign_plan_objects') return archivePlanObjects(db, request, actor, accountId, simulate)
  if (request.action_type !== 'create_campaign_paused') return { status: 'NOT_A_PLAN_REQUEST' }

  const version = await readVersion(db, request, accountId)
  if (!isVersion(version)) return version
  const { spec } = version
  if (request.status === 'failed') {
    const inFlight = await rollbackInFlight(db, request.id, accountId)
    if (inFlight === null) return dbError('rollback read', null)
    if (inFlight) return ROLLBACK_PENDING
  }
  const loaded = await loadPlanContext(db, accountId)
  if (!loaded.ok) return { status: 'PRECONDITION_UNAVAILABLE', message: 'The account could not be read to re-validate the plan. Nothing was sent to Meta.' }
  const { validation } = evaluatePlan(spec, loaded.context)
  if (!validation.ok) {
    return { status: 'REVALIDATION_FAILED', message: 'The plan no longer validates against the account. Nothing was sent to Meta.', validation: validation.issues.filter((i) => i.severity === 'blocker') }
  }
  const creator = simulate ? simulatedCreator(request.id) : liveCreator()
  if (!creator) return { status: 'PRECONDITION_UNAVAILABLE', message: 'Meta write credentials are unavailable. Nothing was created.' }
  const metaAccount = normalizeMetaAccountId(loaded.context.account.metaAccountId)
  if (!metaAccount) return dbError('account read', null)

  const claimed = await claim(db, request, accountId, actor)
  if (!('id' in claimed)) return claimed
  const logId = String(claimed.id)
  // Security review L1: everything acted on is read again under the lock.
  const fresh = await recheckRequest(db, request, accountId)
  const freshVersion = isRequest(fresh) ? await readVersion(db, fresh, accountId) : fresh
  const rows = isVersion(freshVersion) ? await loadObjectRows(db, version.id, accountId) : null
  if (!isRequest(fresh) || !isVersion(freshVersion) || !rows) {
    const refusal = !isRequest(fresh) ? fresh : !isVersion(freshVersion) ? freshVersion : dbError('object read', null)
    await release(db, accountId, logId, String(refusal.status ?? 'ERROR'))
    return refusal
  }
  if (freshVersion.status !== 'creating' && !(await setVersionStatus(db, version.id, accountId, 'creating'))) {
    await finalize(db, accountId, logId, request, { logStatus: 'failed', verified: false, crStatus: 'failed', result: { status: 'ERROR' }, error: 'VERSION_STATUS' })
    return dbError('version status', null)
  }
  const ctx: CreationContext = {
    db, accountId, metaAccount, versionId: version.id, changeRequestId: request.id, markerSeed: markerSeed(version.id, request.id),
    timeZone: loaded.context.account.timezone, pageId: loaded.context.account.pageId ?? '', creator, simulated: simulate, rows,
  }
  try {
    await createPlanObjects(ctx, spec)
  } catch (error) {
    const step = error instanceof CreationStepError ? error : new CreationStepError('UNEXPECTED', 'unknown')
    if (!(error instanceof CreationStepError)) console.error('[CAMPAIGN PLAN EXEC] unexpected creation error:', error instanceof Error ? error.message : 'unknown')
    const result = { status: 'PARTIAL_FAILURE', failed_at: step.key, error: { code: step.code, ...step.detail }, objects: objectSummary(ctx.rows), message: PARTIAL_GUIDANCE, simulated: simulate }
    await setVersionStatus(db, version.id, accountId, 'failed')
    return (await finalize(db, accountId, logId, request, { logStatus: 'failed', verified: false, crStatus: 'failed', result, error: step.code })) ?? { ...result, change_request_id: request.id }
  }
  const verification = await verifyPlanObjects(ctx, spec)
  const allVerified = verification.unverified.length === 0
  const status = simulate ? 'DEMO_SIMULATED' : allVerified ? 'CREATED_PAUSED' : 'CREATED_UNVERIFIED'
  const message = simulate ? DEMO_PLAN_LABEL : allVerified
    ? 'Created and verified: every object is PAUSED. Turn it on in Meta Ads Manager when you are ready.'
    : 'Created PAUSED, but some objects did not read back as planned (any that read as active were paused again). Check them in Ads Manager.'
  const result = { status, simulated: simulate, ...(simulate ? { label: DEMO_PLAN_LABEL } : {}), objects: objectSummary(ctx.rows), unverified: verification.unverified, message }
  await setVersionStatus(db, version.id, accountId, 'created_paused')
  return (await finalize(db, accountId, logId, request, { logStatus: simulate ? 'simulated' : allVerified ? 'verified' : 'applied_unverified', verified: allVerified && !simulate, crStatus: 'executed', result }))
    ?? { ...result, change_request_id: request.id }
}

/** Apply an approved rollback: archive exactly the objects the original creation recorded. */
async function archivePlanObjects(db: Db, cr: PlanRequestRow, actor: string, accountId: string, simulate: boolean): Promise<Record<string, unknown>> {
  const ids = Array.isArray(cr.params.meta_ids) ? (cr.params.meta_ids as unknown[]).map(String) : []
  const { data, error } = await db.from('campaign_plan_objects').select('id, meta_id, object_kind, marker, local_key').eq('change_request_id', String(cr.rollback_of)).eq('ad_account_id', accountId)
  if (error) return dbError('rollback objects read', error)
  const rows = (data ?? []) as Array<{ id: string; meta_id: string | null; object_kind: string; marker: string; local_key: string }>
  const recorded = new Map(createdByRequest(rows, String(cr.campaign_plan_version_id), String(cr.rollback_of)).map((o) => [o.meta_id as string, o]))
  if (ids.length === 0 || ids.some((id) => !recorded.has(id) || recorded.get(id)?.object_kind === 'creative')) {
    return { status: 'INTEGRITY_MISMATCH', message: 'The rollback names an object the creation did not record. Nothing was archived.' }
  }
  const creator = simulate ? simulatedCreator(cr.id) : liveCreator()
  if (!creator) return { status: 'PRECONDITION_UNAVAILABLE', message: 'Meta write credentials are unavailable. Nothing was archived.' }
  const claimed = await claim(db, cr, accountId, actor)
  if (!('id' in claimed)) return claimed
  const fresh = await recheckRequest(db, cr, accountId)
  if (!isRequest(fresh)) { await release(db, accountId, String(claimed.id), String(fresh.status ?? 'ERROR')); return fresh }
  const failures: Array<{ meta_id: string; code: string }> = []
  for (const id of ids) {
    const outcome = await creator.setStatus(id, 'ARCHIVED')
    if (!outcome.ok) failures.push({ meta_id: id, code: outcome.error?.code ?? 'META_REJECTED' })
    await db.from('campaign_plan_objects').update({ state: outcome.ok ? 'archived' : 'archive_failed' }).eq('id', (recorded.get(id) as { id: string }).id).eq('ad_account_id', accountId)
  }
  const ok = failures.length === 0
  if (ok) await setVersionStatus(db, cr.campaign_plan_version_id as string, accountId, 'archived')
  const result = {
    status: ok ? (simulate ? 'DEMO_SIMULATED' : 'ARCHIVED') : 'PARTIAL_FAILURE', simulated: simulate, archived: ids.length - failures.length, failures,
    message: ok ? (simulate ? 'Demo: simulated — archived in the sample data only.' : `Archived ${ids.length} paused object(s).`) : 'Some objects could not be archived. Apply again to retry, or archive them in Ads Manager.',
  }
  return (await finalize(db, accountId, String(claimed.id), cr, { logStatus: ok ? (simulate ? 'simulated' : 'verified') : 'failed', verified: ok && !simulate, crStatus: ok ? 'executed' : 'failed', result }))
    ?? { ...result, change_request_id: cr.id }
}
