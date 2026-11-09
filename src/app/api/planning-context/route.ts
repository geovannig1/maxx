import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
  type ResolvedActiveAccount,
} from '@/lib/accounts/active-account'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { normalizeCanonicalUrl } from '@/lib/planning-context/contracts'
import { readGovernedPlanningContextReviewForAccount } from '@/lib/planning-context/resolver'
import {
  executePlanningContextCommand,
  planningContextCommandSchema,
  PlanningContextStoreError,
} from '@/lib/planning-context/store'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'
const MAX_COMMAND_BYTES = 128 * 1024

interface OwnerContext {
  actor: string
  account: ResolvedActiveAccount
}

async function authorizeOwnerAndAccount(): Promise<OwnerContext | Response> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const active = await resolveOnlyActiveAccount(getAdminClient())
  if (!active.ok) {
    return Response.json({
      error: 'Governed planning context requires exactly one active ad account.',
      code: activeAccountErrorCode(active.reason),
    }, { status: activeAccountErrorStatus(active.reason) })
  }
  return { actor: user.email ?? user.id, account: active.account }
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

function mutationRequestBoundary(req: Request): Response | null {
  const mediaType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return Response.json({ error: 'Content-Type must be application/json.' }, { status: 415 })
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: 'Cross-origin mutation is forbidden.' }, { status: 403 })
  }
  const origin = req.headers.get('origin')
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) {
        return Response.json({ error: 'Cross-origin mutation is forbidden.' }, { status: 403 })
      }
    } catch {
      return Response.json({ error: 'Invalid request origin.' }, { status: 403 })
    }
  }
  return null
}

async function readBoundedBody(req: Request): Promise<string | Response> {
  const declared = req.headers.get('content-length')
  if (declared != null) {
    const declaredLength = Number(declared)
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return Response.json({ error: 'Invalid Content-Length.' }, { status: 400 })
    }
    if (declaredLength > MAX_COMMAND_BYTES) {
      return Response.json({ error: 'Governed planning-context command is too large.' }, { status: 413 })
    }
  }
  if (!req.body) {
    return Response.json({ error: 'Invalid governed planning-context command.' }, { status: 400 })
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_COMMAND_BYTES) {
      await reader.cancel('planning-context payload exceeds byte limit')
      return Response.json({ error: 'Governed planning-context command is too large.' }, { status: 413 })
    }
    chunks.push(value)
  }

  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined)
  } catch {
    return Response.json({ error: 'Invalid governed planning-context command.' }, { status: 400 })
  }
}

export async function GET(req: Request) {
  const context = await authorizeOwnerAndAccount()
  if (context instanceof Response) return noStore(context)

  const limited = await enforceApiRateLimit({
    bucket: 'planning_context_read',
    actorKey: context.actor,
    limit: 120,
    windowSeconds: 3600,
  })
  if (limited) return noStore(limited)

  const requestedUrlInput = new URL(req.url).searchParams.get('landing_page_url')
  let requestedUrl: string | null = null
  if (requestedUrlInput != null) {
    try {
      requestedUrl = normalizeCanonicalUrl(requestedUrlInput)
    } catch {
      return noStore(Response.json({ error: 'Invalid landing-page identity.' }, { status: 400 }))
    }
  }
  const review = await readGovernedPlanningContextReviewForAccount(
    getAdminClient(),
    context.account.id,
    requestedUrl,
  )
  return noStore(Response.json({
    data: review,
    authority: 'context_only',
    campaign_settings_authorized: false,
    meta_write_performed: false,
  }))
}

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const context = await authorizeOwnerAndAccount()
  if (context instanceof Response) return noStore(context)

  const boundaryError = mutationRequestBoundary(req)
  if (boundaryError) return noStore(boundaryError)

  const limited = await enforceApiRateLimit({
    bucket: 'planning_context_write',
    actorKey: context.actor,
    limit: 30,
    windowSeconds: 3600,
  })
  if (limited) return noStore(limited)

  const bodyRead = await readBoundedBody(req)
  if (bodyRead instanceof Response) return noStore(bodyRead)
  let body: unknown = null
  try {
    body = JSON.parse(bodyRead)
  } catch {
    return noStore(Response.json({ error: 'Invalid governed planning-context command.' }, { status: 400 }))
  }
  const parsed = planningContextCommandSchema.safeParse(body)
  if (!parsed.success) {
    return noStore(Response.json({ error: 'Invalid governed planning-context command.' }, { status: 400 }))
  }

  try {
    const data = await executePlanningContextCommand(
      getAdminClient(),
      context.account.id,
      context.actor,
      parsed.data,
    )
    return noStore(Response.json({
      data,
      authority: 'context_only',
      campaign_settings_authorized: false,
      meta_write_performed: false,
    }))
  } catch (error) {
    if (error instanceof PlanningContextStoreError) {
      console.error('[planning-context] governed command rejected', {
        code: error.code,
      })
      return noStore(Response.json({
        error: 'Governed planning-context command was rejected.',
        code: error.code,
      }, { status: error.status }))
    }
    console.error('[planning-context] unexpected command failure', error)
    return noStore(Response.json({
      error: 'Governed planning-context command failed.',
      code: 'CONTEXT_COMMAND_FAILED',
    }, { status: 500 }))
  }
}
