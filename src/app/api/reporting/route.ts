import { after, NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { ownerGate } from '@/lib/auth/owner'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { loadReportingSection } from '@/lib/reporting/loader'
import { ReportingContextSchema, type ReportingSectionName } from '@/lib/reporting/contracts'
import { previousReportingRange, resolveReportingRange } from '@/lib/reporting/range'
import { readReportingUser } from '@/lib/reporting/session'
import { REPORTING_IDENTITY_TIMEOUT_MS, withReportingDeadline } from '@/lib/reporting/deadline'
import { acceptsReportingStream, streamReportingReport } from '@/lib/reporting/stream-response'
import { getAdminClient } from '@/lib/supabase/admin'
import { makeReportingSnapshotScope, readReportingHistoryEntity } from '@/lib/reporting/snapshot-scope'
import { readLatestReportingSnapshot, readReportingSnapshotById } from '@/lib/reporting/snapshot-store'
import { claimReportingRefresh, readReportingRefreshJob, type ReportingRefreshDatabase, type ReportingRefreshJob } from '@/lib/reporting/refresh-jobs'
import { runReportingRefresh } from '@/lib/reporting/refresh-worker'
import { acceptsPreparedReporting, preparedReportingReply } from '@/lib/reporting/prepared-response'
import { REPORTING_PREPARED_TYPE } from '@/lib/reporting/prepared-contract'
import { compactReportingPacket } from '@/lib/reporting/packet-format'
import { PreparedRequestError, readPreparedRefreshCommand } from '@/lib/reporting/prepared-request'
import type { ReportingSnapshotScope } from '@/lib/reporting/snapshot-scope'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { configuredBusinessLocale } from '@/config/business-config'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'
export const maxDuration = 180
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Accept, Accept-Encoding' }
const compress = promisify(gzip)
async function reportingJson(request: NextRequest, body: unknown, status = 200, contentType = 'application/json') {
  const responseHeaders = { ...headers, 'Content-Type': contentType }
  const acceptsGzip = request.headers.get('accept-encoding')?.split(',').some(value => {
    const [encoding, quality] = value.trim().split(';')
    return encoding === 'gzip' && (!quality || Number(quality.trim().replace(/^q=/, '')) > 0)
  })
  if (acceptsGzip) return new Response(new Uint8Array(await compress(JSON.stringify(body))), {
    status, headers: { ...responseHeaders, 'Content-Encoding': 'gzip' },
  })
  return Response.json(body, { status, headers: responseHeaders })
}
function failure(error: string, status: number, code?: string) {
  return Response.json({ error, ...(code ? { code } : {}) }, {
    status,
    headers: code ? { ...headers, 'x-reporting-error-code': code } : headers,
  })
}

async function ownerError(request: NextRequest): Promise<Response | null> {
  const user = await readReportingUser(async () => {
    const supabase = await createClient()
    return supabase.auth.getUser()
  }, request.signal)
  if (!user) return failure('Sign in to view reporting.', 401)
  return ownerGate(user).allowed ? null : failure('Owner access is required to view reporting.', 403)
}

async function reportingRequestContext(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const section = params.get('section')
  if (!section || !['meta', 'business', 'website', 'measurement'].includes(section)) return failure('Choose a supported reporting source.', 400)
  const detailIds = params.get('details')?.split(',').filter(Boolean) ?? []
  if (detailIds.length > 2 || detailIds.some(id => !/^[A-Za-z0-9_-]{1,160}$/.test(id))) return failure('Choose at most two valid ads for detail.', 400)
  let historyEntity
  try { historyEntity = readReportingHistoryEntity(params, section as ReportingSectionName, detailIds) }
  catch { return failure('Choose one valid campaign or ad set for history, separately from ad detail.', 400) }
  let range
  try {
    range = resolveReportingRange({ from: params.get('from') ?? undefined, to: params.get('to') ?? undefined, range: params.get('range') ?? undefined })
  } catch { return failure('Choose valid start and end dates that include a completed account day.', 400) }
  const active = await withReportingDeadline(() => resolveOnlyActiveAccount(), REPORTING_IDENTITY_TIMEOUT_MS, request.signal)
  if (!active.ok) return failure('Reporting account ownership could not be resolved.',
    active.reason === 'ambiguous' ? 409 : active.reason === 'not_found' ? 404 : 503,
    activeAccountErrorCode(active.reason))
  // Configured zone and currency (src/config/business-config.ts). The database refuses a snapshot or
  // refresh scope whose timezone or currency differs from the ad account's own (migration
  // 20261110000000), so a configuration that disagrees with the account cannot publish evidence.
  const locale = configuredBusinessLocale()
  const context = ReportingContextSchema.parse({
    account: { id: active.account.id, metaAccountId: active.account.accountId, name: active.account.accountName },
    range: { from: range.from, to: range.to }, comparison: previousReportingRange({ from: range.from, to: range.to }),
    timezone: locale.timezone, currency: locale.currency, asOf: new Date().toISOString(),
  })
  const notes = range.clampedFuture
    ? ['The requested end date included an open or future account day. Reporting ends yesterday in the account timezone.'] : []
  return { params, section: section as ReportingSectionName, detailIds, historyEntity, range, context, notes }
}

function preparedScope(input: Exclude<Awaited<ReturnType<typeof reportingRequestContext>>, Response>) {
  return makeReportingSnapshotScope(input.section, input.context, {
    requestedRange: { from: input.params.get('from') ?? input.range.from, to: input.params.get('to') ?? input.range.to },
    detailIds: input.section === 'meta' ? input.detailIds : [],
    ...(input.historyEntity ? { historyEntity: input.historyEntity } : {}),
  })
}

async function preparedResponse(
  db: ReportingRefreshDatabase, scope: ReportingSnapshotScope, job: ReportingRefreshJob | null,
  request: NextRequest, status = 200,
): Promise<Response> {
  const signal = request.signal
  const saved = job?.status === 'complete' && job.snapshotId
    ? await readReportingSnapshotById(db, scope, job.snapshotId, signal)
    : await readLatestReportingSnapshot(db, scope, signal)
  if (job?.status === 'complete' && (!job.snapshotId || !saved)) {
    return failure('The completed reporting snapshot is temporarily unavailable.', 503)
  }
  return reportingJson(request, preparedReportingReply(scope, saved, job), status, REPORTING_PREPARED_TYPE)
}

export async function GET(request: NextRequest) {
  try {
    const denied = await ownerError(request)
    if (denied) return denied
    const input = await reportingRequestContext(request)
    if (input instanceof Response) return input
    const { params, section, detailIds, historyEntity, context, notes } = input
    if (process.env.REPORTING_PREPARED_ENABLED === 'on' && acceptsPreparedReporting(request.headers.get('accept'))) {
      const scope = preparedScope(input)
      const jobId = params.get('job')
      if (jobId !== null && !z.string().uuid().safeParse(jobId).success) return failure('Choose a valid reporting refresh.', 400)
      const db = getAdminClient()
      const job = await readReportingRefreshJob(db, scope, jobId ?? undefined, request.signal)
      if (jobId !== null && !job) return failure('This reporting refresh was not found for the selected source and dates.', 404)
      return await preparedResponse(db, scope, job, request)
    }
    if ((section === 'meta' || section === 'business') && acceptsReportingStream(request.headers.get('accept'))) {
      return streamReportingReport(section, context, params.get('refresh') === '1', detailIds, request.signal, notes, historyEntity)
    }
    const packet = historyEntity
      ? await loadReportingSection(section, context, params.get('refresh') === '1', detailIds, undefined, undefined, { historyEntity })
      : await loadReportingSection(section, context, params.get('refresh') === '1', detailIds)
    const body = { ...packet, notes: [...packet.notes, ...notes] }
    return await reportingJson(request, compactReportingPacket(body))
  } catch { return failure('Reporting is temporarily unavailable. Retry to request fresh data.', 503) }
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(request)
  if (crossOrigin) return crossOrigin
  if (process.env.REPORTING_PREPARED_ENABLED !== 'on') return failure('Prepared reporting is not enabled.', 503)
  try {
    const denied = await ownerError(request)
    if (denied) return denied
    if (request.headers.get('origin') !== request.nextUrl.origin) return failure('Send reporting refreshes from this application.', 403)
    if (!acceptsPreparedReporting(request.headers.get('accept'))) return failure('Request the prepared reporting format.', 406)
    const command = await readPreparedRefreshCommand(request)
    const input = await reportingRequestContext(request)
    if (input instanceof Response) return input
    const scope = preparedScope(input)
    const db = getAdminClient()
    const claim = await claimReportingRefresh(db, scope, command.refresh, request.signal)
    if (claim.claimed && claim.job) {
      const job = claim.job
      after(() => runReportingRefresh(db, job, input.context.account.name))
    }
    return await preparedResponse(db, scope, claim.job, request, claim.job?.status === 'running' ? 202 : 200)
  } catch (error) {
    if (error instanceof PreparedRequestError) return failure(error.message, error.status)
    return failure('Reporting is temporarily unavailable. Retry to request fresh data.', 503)
  }
}
