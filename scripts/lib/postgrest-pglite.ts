import type { PGlite } from '@electric-sql/pglite'

// A PostgREST subset translated into SQL against PGlite (the shipped schema in memory). Shared by the
// demo backend (scripts/demo/rest.ts) and the hermetic DB-test transport (tests/db/postgrest-pglite.ts).
// It covers select with eq/neq/is/in/gte/gt/lt/lte and not.is.null filters, aliases (`alias:col`),
// JSON paths (`raw->key`), order, limit/offset, head counts, insert/upsert with on_conflict, update,
// filtered delete and rpc. It is not a running PostgREST server: no JWT role switching, no embedded
// resources.
//
// mode 'strict' (tests): anything outside the subset is a 400 naming it, so a writer that starts using
// an unsupported feature fails loudly instead of being approximated.
// mode 'demo': an unsupported request answers an empty result (header x-demo-unsupported), so a page
// shows its empty state rather than an error; the demo also accepts is.true/is.false, GET rpc without
// arguments, a schema root listing and a GET count, refuses an unfiltered update, and parses numerics
// in write and rpc results too.

export type PostgrestMode = 'strict' | 'demo'

const IDENT = /^[a-z_][a-z0-9_]*$/
const RESERVED = new Set(['select', 'limit', 'on_conflict', 'columns', 'order', 'offset'])
const JSON_PATH = /^([a-z_][a-z0-9_]*)(->>?)([A-Za-z_][A-Za-z0-9_]*)$/
const OPERATORS: Record<string, string> = { eq: '=', neq: '<>', gte: '>=', lt: '<', gt: '>', lte: '<=' }
// As PostgREST: a `date` is 'YYYY-MM-DD' text (OID 1082), a `numeric` is a JSON number (OID 1700).
const PARSERS = { parsers: { 1082: (v: string) => v, 1700: (v: string) => Number(v) } }

class Unsupported extends Error {
  constructor(what: string) { super(`postgrest-pglite: unsupported ${what}`) }
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Unsupported(`identifier ${JSON.stringify(name)}`)
  return `"${name}"`
}

function sqlValue(v: unknown): unknown {
  return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
}

function whereClause(params: URLSearchParams, values: unknown[], mode: PostgrestMode): string {
  const terms: string[] = []
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue
    const col = ident(key)
    const dot = raw.indexOf('.')
    const op = raw.slice(0, dot)
    const arg = raw.slice(dot + 1)
    if (op === 'is' && arg === 'null') terms.push(`${col} IS NULL`)
    else if (op === 'not' && arg === 'is.null') terms.push(`${col} IS NOT NULL`)
    else if (mode === 'demo' && op === 'is' && (arg === 'true' || arg === 'false')) terms.push(`${col} IS ${arg.toUpperCase()}`)
    else if (op === 'in') {
      const items = arg.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''))
      terms.push(`${col} IN (${items.map((item) => { values.push(item); return `$${values.length}` }).join(',')})`)
    } else {
      const sqlOp = OPERATORS[op]
      if (!sqlOp) throw new Unsupported(`filter ${key}=${raw}`)
      values.push(arg)
      terms.push(`${col} ${sqlOp} $${values.length}`)
    }
  }
  return terms.length ? `WHERE ${terms.join(' AND ')}` : ''
}

function column(spec: string): string {
  const colon = spec.indexOf(':')
  const alias = colon > 0 ? spec.slice(0, colon) : null
  const source = colon > 0 ? spec.slice(colon + 1) : spec
  const jsonPath = JSON_PATH.exec(source)
  if (jsonPath) return `${ident(jsonPath[1])}${jsonPath[2]}'${jsonPath[3]}' AS ${ident(alias ?? jsonPath[3])}`
  return alias ? `${ident(source)} AS ${ident(alias)}` : ident(source)
}

function columns(select: string | null): string {
  if (!select || select === '*') return '*'
  return select.split(',').map((c) => column(c.trim())).join(', ')
}

function orderBy(order: string | null): string {
  if (!order) return ''
  return `ORDER BY ${order.split(',').map((term) => {
    const [col, dir = 'asc', nulls] = term.split('.')
    if (dir !== 'asc' && dir !== 'desc') throw new Unsupported(`order ${term}`)
    return `${ident(col)} ${dir.toUpperCase()}${nulls === 'nullsfirst' ? ' NULLS FIRST' : nulls === 'nullslast' ? ' NULLS LAST' : ''}`
  }).join(', ')}`
}

async function rpc(db: PGlite, fn: string, request: Request, mode: PostgrestMode): Promise<unknown> {
  const body = mode === 'demo' && request.method === 'GET' ? {} : await request.json() as Record<string, unknown>
  const keys = Object.keys(body)
  const { rows: meta } = await db.query<{ retset: boolean }>(
    `SELECT proretset AS retset FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [fn])
  if (meta.length !== 1) throw new Unsupported(`rpc ${fn} (not found or overloaded)`)
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`,
    keys.map((k) => sqlValue(body[k])), mode === 'demo' ? PARSERS : undefined)
  if (meta[0].retset) return rows
  const row = rows[0] ?? null
  return row && Object.keys(row).length === 1 && fn in row ? row[fn] : row
}

async function write(db: PGlite, table: string, url: URL, request: Request, mode: PostgrestMode): Promise<unknown[]> {
  const body = await request.json() as Record<string, unknown> | Array<Record<string, unknown>>
  const rows = Array.isArray(body) ? body : [body]
  const prefer = request.headers.get('Prefer') ?? ''
  const returning = /return=representation/.test(prefer) ? `RETURNING ${columns(url.searchParams.get('select'))}` : ''
  const parsers = mode === 'demo' ? PARSERS : undefined
  if (request.method === 'PATCH') {
    const values: unknown[] = []
    const sets = Object.keys(rows[0]).map((k) => { values.push(sqlValue(rows[0][k])); return `${ident(k)} = $${values.length}` })
    const where = whereClause(url.searchParams, values, mode)
    if (!where && mode === 'demo') throw new Unsupported('unfiltered PATCH')
    return (await db.query(`UPDATE public.${ident(table)} SET ${sets.join(', ')} ${where} ${returning}`, values, parsers)).rows
  }
  const conflict = url.searchParams.get('on_conflict')
  const resolution = /resolution=(ignore|merge)-duplicates/.exec(prefer)?.[1]
  if (resolution && !conflict && mode === 'strict') throw new Unsupported('resolution without on_conflict')
  const out: unknown[] = []
  for (const row of rows) {
    const keys = Object.keys(row)
    const target = conflict ? conflict.split(',').map(ident).join(',') : ''
    const onConflict = !resolution || !conflict ? ''
      : resolution === 'ignore' ? `ON CONFLICT (${target}) DO NOTHING`
      : `ON CONFLICT (${target}) DO UPDATE SET ${keys.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ')}`
    out.push(...(await db.query(`INSERT INTO public.${ident(table)} (${keys.map(ident).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict} ${returning}`,
      keys.map((k) => sqlValue(row[k])), parsers)).rows)
  }
  return out
}

const wantsObject = (request: Request) => (request.headers.get('Accept') ?? '').startsWith('application/vnd.pgrst.object+json')

function emptyFor(request: Request, reason: string): Response {
  const headers = { 'x-demo-unsupported': reason.slice(0, 120), 'content-range': '*/0' }
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : Response.json(wantsObject(request) ? null : [], { headers })
}

async function count(db: PGlite, table: string, url: URL, mode: PostgrestMode): Promise<number> {
  const values: unknown[] = []
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${ident(table)} ${whereClause(url.searchParams, values, mode)}`, values)
  return rows[0].n
}

async function translate(db: PGlite, request: Request, mode: PostgrestMode): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/rest\/v1\/?/, '')
  if (mode === 'demo' && path === '') {
    const { rows } = await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`)
    return Response.json({ paths: Object.fromEntries(rows.map((r) => [`/${r.t}`, {}])) })
  }
  if (path.startsWith('rpc/')) return Response.json(await rpc(db, path.slice(4), request, mode))
  const table = path
  ident(table)
  const prefer = request.headers.get('Prefer') ?? ''
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'content-range': `*/${await count(db, table, url, mode)}` } })
  }
  if (mode === 'demo' && request.method === 'GET' && /count=exact/.test(prefer) && url.searchParams.get('select')?.includes('count')) {
    return new Response('[]', { status: 200, headers: { 'content-range': `*/${await count(db, table, url, mode)}`, 'content-type': 'application/json' } })
  }
  if (request.method === 'GET') {
    const values: unknown[] = []
    const limit = url.searchParams.get('limit')
    const offset = url.searchParams.get('offset')
    const { rows } = await db.query(`SELECT ${columns(url.searchParams.get('select'))} FROM public.${ident(table)} ${whereClause(url.searchParams, values, mode)} ${orderBy(url.searchParams.get('order'))}
      ${limit ? `LIMIT ${Number(limit)}` : ''} ${offset ? `OFFSET ${Number(offset)}` : ''}`, values, PARSERS)
    return Response.json(wantsObject(request) ? rows[0] ?? null : rows)
  }
  if (request.method === 'POST' || request.method === 'PATCH') {
    const rows = await write(db, table, url, request, mode)
    // As PostgREST: `.single()` (the object Accept header) answers the one row, not an array.
    if (!/return=representation/.test(prefer)) return new Response(null, { status: 201 })
    return Response.json(wantsObject(request) ? rows[0] ?? null : rows, { status: 201 })
  }
  if (request.method === 'DELETE') {
    const values: unknown[] = []
    const where = whereClause(url.searchParams, values, mode)
    if (!where) throw new Unsupported('unfiltered DELETE')
    await db.query(`DELETE FROM public.${ident(table)} ${where}`, values)
    return new Response(null, { status: 204 })
  }
  throw new Unsupported(`method ${request.method}`)
}

/** Answer one `/rest/v1/...` request against `db`. */
export async function handlePostgrest(db: PGlite, request: Request, mode: PostgrestMode): Promise<Response> {
  try {
    return await translate(db, request, mode)
  } catch (error) {
    if (error instanceof Unsupported && mode === 'demo') return emptyFor(request, error.message)
    const failure = error as { code?: string; message?: string }
    const fallback = mode === 'demo' ? { code: 'demo_failure', message: 'demo query failed' } : { code: 'fixture_failure', message: 'fixture failed' }
    return Response.json({ code: failure.code ?? fallback.code, message: failure.message ?? fallback.message }, { status: 400 })
  }
}
