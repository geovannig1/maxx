import 'server-only'
import type { z } from 'zod'
import { readBoundedBody } from '@/lib/security/bounded-body'

// Shared request handling for the Copy studio routes: private no-store JSON, and a body that is
// size-capped BEFORE it is buffered, then parsed and validated against the route's schema.

const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

export function privateJson(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, { ...init, headers: { ...PRIVATE_NO_STORE, ...init?.headers } })
}

export async function parseCopyBody<S extends z.ZodType>(req: Request, maxBytes: number, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  const body = await readBoundedBody(req, maxBytes)
  if (!body.ok) {
    return body.error === 'too_large'
      ? { ok: false, response: privateJson({ error: 'The request is too large.', code: 'BODY_TOO_LARGE' }, { status: 413 }) }
      : { ok: false, response: privateJson({ error: 'Invalid request', code: 'INVALID_REQUEST' }, { status: 400 }) }
  }
  let json: unknown
  try { json = JSON.parse(body.rawBody) } catch { return { ok: false, response: privateJson({ error: 'Invalid request', code: 'INVALID_REQUEST' }, { status: 400 }) } }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(body)'))].slice(0, 8)
    return { ok: false, response: privateJson({ error: 'Invalid request', code: 'INVALID_REQUEST', fields }, { status: 400 }) }
  }
  return { ok: true, data: parsed.data }
}
