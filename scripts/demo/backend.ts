import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { PGlite } from '@electric-sql/pglite'
import { handleRest } from './rest'

// Loopback stand-in for Supabase in the demo: Auth answers for one fictional owner, and REST reads
// the in-memory sample database. Listens on 127.0.0.1 only. The token below is not a real credential:
// nothing outside this process accepts it, and the app accepts it only because the demo points
// NEXT_PUBLIC_SUPABASE_URL at this server.

export const DEMO_USER = {
  id: '00000000-0000-4000-8000-00000000d0e0',
  email: 'owner@example.com',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
  email_confirmed_at: '2026-01-01T00:00:00Z',
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const EXPIRES = 4_102_444_800
export const DEMO_ACCESS = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: DEMO_USER.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES })}.demo-signature`

const session = () => ({ access_token: DEMO_ACCESS, refresh_token: 'demo-refresh', expires_at: EXPIRES, expires_in: 86_400, token_type: 'bearer', user: DEMO_USER })

/** The @supabase/ssr cookie (name `sb-<first host label>-auth-token`) that signs the browser in. */
export function demoSessionCookie(supabaseUrl: string): string {
  const ref = new URL(supabaseUrl).hostname.split('.')[0]
  return `sb-${ref}-auth-token=base64-${encode(session())}; Path=/; SameSite=Lax`
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function authResponse(url: URL, method: string, authorization: string | undefined): Response {
  const authed = authorization === `Bearer ${DEMO_ACCESS}`
  switch (url.pathname) {
    case '/auth/v1/user':
      return authed ? Response.json(DEMO_USER) : Response.json({ message: 'Invalid demo session' }, { status: 401 })
    case '/auth/v1/settings':
      return Response.json({ disable_signup: true, mailer_autoconfirm: false, external: { email: true } })
    case '/auth/v1/token':
      return Response.json(session())
    case '/auth/v1/logout':
      return new Response(null, { status: 204 })
    case '/auth/v1/admin/users':
      return method === 'GET' ? Response.json({ users: [DEMO_USER] }) : Response.json({ msg: 'read-only demo' }, { status: 405 })
    default:
      return Response.json({ message: 'not available in the demo' }, { status: 404 })
  }
}

export function startBackend(db: PGlite, port: number): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      const method = request.method ?? 'GET'
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
      const headers = new Headers(Object.entries(request.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])) as Array<[string, string]>)
      const reply = url.pathname.startsWith('/rest/v1')
        ? await handleRest(db, new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined }))
        : authResponse(url, method, request.headers.authorization)
      response.writeHead(reply.status, Object.fromEntries(reply.headers.entries()))
      response.end(Buffer.from(await reply.arrayBuffer()))
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"message":"demo backend error"}')
    }
  })
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)))
}
