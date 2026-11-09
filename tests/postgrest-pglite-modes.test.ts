import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgliteSupabase } from './db/postgrest-pglite'
import { handleRest } from '../scripts/demo/rest'

// the demo backend and the DB tests translate the same PostgREST subset into SQL over PGlite
// through one shared module (scripts/lib/postgrest-pglite.ts). This pins what each consumer sees, so
// the consolidation keeps behaviour identical: the test shim is STRICT (anything outside the subset is
// a 400, so a writer cannot pass on an approximation); the demo answers an empty result instead and
// has a few read conveniences of its own.

let db: PGlite
const SCHEMA = `
  CREATE TABLE public.items (id int PRIMARY KEY, name text, flag boolean NOT NULL DEFAULT false, amount numeric, day date, data jsonb);
  CREATE FUNCTION public.add_one(x int) RETURNS int LANGUAGE sql AS 'SELECT x + 1';
  CREATE FUNCTION public.answer() RETURNS int LANGUAGE sql AS 'SELECT 42';
`
const SEED = `
  INSERT INTO public.items (id, name, flag, amount, day, data) VALUES
    (1, 'one', true, 1.50, '2026-09-02', '{"k":"v1"}'), (2, 'two', false, 2.25, '2026-09-03', '{"k":"v2"}'), (3, NULL, false, NULL, NULL, NULL);
`
beforeAll(async () => { db = new PGlite(); await db.exec(SCHEMA) })
beforeEach(async () => { await db.exec(`TRUNCATE public.items; ${SEED}`) })
afterAll(async () => { await db.close() })

const BASE = 'http://127.0.0.1:1/rest/v1'
const demo = (path: string, init?: RequestInit) => handleRest(db, new Request(`${BASE}${path}`, init))

describe('shared PostgREST subset (both consumers)', () => {
  it('select with filters, aliases, JSON paths, order, limit and offset', async () => {
    const strict = pgliteSupabase(db)
    const { data, error } = await strict.from('items').select('id,label:name,k:data->>k').not('name', 'is', null).gte('id', 1).order('id', { ascending: false }).range(0, 0)
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 2, label: 'two', k: 'v2' }])
    expect(await (await demo('/items?select=id,label:name,k:data->>k&name=not.is.null&id=gte.1&order=id.desc&limit=1&offset=0')).json())
      .toEqual([{ id: 2, label: 'two', k: 'v2' }])
  })

  it('dates stay YYYY-MM-DD and numerics are JSON numbers on reads', async () => {
    const { data } = await pgliteSupabase(db).from('items').select('day,amount').eq('id', 1)
    expect(data).toEqual([{ day: '2026-09-02', amount: 1.5 }])
    expect(await (await demo('/items?select=day,amount&id=eq.1')).json()).toEqual([{ day: '2026-09-02', amount: 1.5 }])
  })

  it('in-filters, head counts, upserts, updates, filtered deletes and rpc', async () => {
    const strict = pgliteSupabase(db)
    expect((await strict.from('items').select('*', { count: 'exact', head: true }).in('id', [1, 2])).count).toBe(2)
    expect((await demo('/items?id=in.(1,2)', { method: 'HEAD' })).headers.get('content-range')?.split('/')[1]).toBe('2')
    await strict.from('items').upsert({ id: 1, name: 'uno' }, { onConflict: 'id' })
    await demo('/items?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 2, name: 'dos' }) })
    await strict.from('items').update({ name: 'tres' }).eq('id', 3)
    await strict.from('items').delete().eq('id', 1)
    expect((await db.query('SELECT id, name FROM public.items ORDER BY id')).rows).toEqual([{ id: 2, name: 'dos' }, { id: 3, name: 'tres' }])
    expect((await strict.rpc('add_one', { x: 1 })).data).toBe(2)
    expect(await (await demo('/rpc/add_one', { method: 'POST', body: JSON.stringify({ x: 2 }) })).json()).toBe(3)
  })
})

describe('strict test shim', () => {
  it('an unsupported request is a 400 naming it, never an approximation', async () => {
    const strict = pgliteSupabase(db)
    const embedded = await strict.from('items').select('id,owner(id)')
    expect(embedded.error?.message).toMatch(/^postgrest-pglite: unsupported identifier/)
    const boolFilter = await strict.from('items').select('id').is('flag', true)
    expect(boolFilter.error?.message).toMatch(/^postgrest-pglite: unsupported filter flag=is\.true/)
    const afterDelete = await strict.from('items').delete().gte('id', 0).then(() => strict.from('items').select('id'))
    expect(afterDelete.data).toEqual([])
  })

  it('records every request', async () => {
    const log: string[] = []
    await pgliteSupabase(db, log).from('items').select('id').eq('id', 1)
    expect(log).toEqual(['GET items'])
  })

  it('updates without a filter, as PostgREST does; write results keep numerics as text', async () => {
    const strict = pgliteSupabase(db)
    const { data } = await strict.from('items').update({ name: 'all' }).neq('id', -1).select('id,amount').order('id')
    expect(data).toEqual([{ id: 1, amount: '1.50' }, { id: 2, amount: '2.25' }, { id: 3, amount: null }])
    const rpc = await fetchStrict('/rpc/answer', { method: 'GET' })
    expect(rpc.status).toBe(400)
  })
})

describe('demo backend', () => {
  it('answers an unsupported request with an empty result marked x-demo-unsupported', async () => {
    const res = await demo('/items?select=id,owner(id)')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-demo-unsupported')).toBeTruthy()
    expect(await res.json()).toEqual([])
    const object = await demo('/items?select=id,owner(id)', { headers: { Accept: 'application/vnd.pgrst.object+json' } })
    expect(await object.json()).toBeNull()
  })

  it('supports is.true/false, GET rpc, a schema root listing and a GET count', async () => {
    expect(await (await demo('/items?select=id&flag=is.true')).json()).toEqual([{ id: 1 }])
    expect(await (await demo('/rpc/answer')).json()).toBe(42)
    expect(Object.keys((await (await demo('/')).json() as { paths: object }).paths)).toContain('/items')
    const count = await demo('/items?select=count', { headers: { Prefer: 'count=exact' } })
    expect(count.headers.get('content-range')?.split('/')[1]).toBe('3')
  })

  it('refuses an unfiltered update instead of rewriting every row', async () => {
    const res = await demo('/items', { method: 'PATCH', body: JSON.stringify({ name: 'all' }) })
    expect(res.headers.get('x-demo-unsupported')).toBeTruthy()
    expect((await db.query(`SELECT count(*)::int AS n FROM public.items WHERE name = 'all'`)).rows).toEqual([{ n: 0 }])
  })

  it('write and rpc results parse numerics as numbers', async () => {
    const res = await demo('/items?id=eq.1&select=id,amount', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: 'x' }) })
    expect(await res.json()).toEqual([{ id: 1, amount: 1.5 }])
  })

  it('a database error is a 400 with the error code', async () => {
    const res = await demo('/items', { method: 'POST', body: JSON.stringify({ id: 1, name: 'dup' }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: '23505' })
  })
})

/** A raw request through the strict shim's transport (for shapes supabase-js cannot express). */
async function fetchStrict(path: string, init: RequestInit): Promise<Response> {
  const client = pgliteSupabase(db) as unknown as { rest: { fetch: typeof fetch } }
  return client.rest.fetch(`${BASE}${path}`, init)
}
