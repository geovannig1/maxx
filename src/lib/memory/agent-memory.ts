import { getAdminClient } from '@/lib/supabase/admin'

export async function storeMemory(params: {
  adAccountDbId: string | null
  type: 'recommendation' | 'outcome' | 'rejection' | 'preference' | 'pattern'
  context: string
  content: string
  tags: string[]
  importance: 1 | 2 | 3 | 4 | 5
  source_type?: string
  source_id?: string
}): Promise<string | null> {
  const supabase = getAdminClient()

  const { data, error } = await supabase
    .from('agent_memory')
    .insert({
      ad_account_id: params.adAccountDbId,
      memory_type: params.type,
      context: params.context,
      content: params.content,
      tags: params.tags,
      importance: params.importance,
      source_type: params.source_type ?? null,
      source_id: params.source_id ?? null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[agent-memory] storeMemory error:', error.message)
    return null
  }

  return data?.id ?? null
}

/**
 * The search term is interpolated into a PostgREST `or=(...)` logic tree. `,` `(` `)` would let it
 * add clauses, `"` and `\` change PostgREST quoting, and `%` / `*` (PostgREST's alias for `%`) are
 * LIKE wildcards. Replacing them with spaces leaves a substring term that cannot change the filter.
 * `_` is kept so terms like `cold_studio` still match; it can only match one extra character.
 */
function literalSearchTerm(raw: string): string {
  return raw.replace(/[,()"\\%*]/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function searchMemory(params: {
  adAccountDbId?: string
  query: string
  tags?: string[]
  type?: string
  limit?: number
  minImportance?: number
}): Promise<
  Array<{
    id: string
    type: string
    context: string
    content: string
    tags: string[]
    importance: number
    created_at: string
  }>
> {
  // A term made only of stripped characters (e.g. "(") would become `ilike.%%`, which matches every row.
  const term = literalSearchTerm(params.query)
  if (term === '') return []

  const supabase = getAdminClient()
  const limit = params.limit ?? 10

  let query = supabase
    .from('agent_memory')
    .select('id, memory_type, context, content, tags, importance, source_type, source_id, created_at')

  if (params.adAccountDbId) {
    query = query.eq('ad_account_id', params.adAccountDbId)
  }

  if (params.type) {
    query = query.eq('memory_type', params.type)
  }

  if (params.minImportance !== undefined) {
    query = query.gte('importance', params.minImportance)
  }

  query = query.or(`context.ilike.%${term}%,content.ilike.%${term}%`)

  if (params.tags && params.tags.length > 0) {
    query = query.contains('tags', params.tags)
  }

  query = query.order('importance', { ascending: false }).order('created_at', { ascending: false }).limit(limit)

  const { data, error } = await query

  if (error) {
    console.error('[agent-memory] searchMemory error:', error.message)
    return []
  }

  if (!data || data.length === 0) return []

  const outcomeSourceIds = data
    .filter((row: { memory_type?: string | null; source_type?: string | null }) => (
      row.memory_type === 'outcome' || row.source_type === 'recommendation_outcome'
    ))
    .map((row: { source_id?: string | null }) => row.source_id)
    .filter((id: string | null | undefined): id is string => !!id)
  const approvedOutcomeSourceIds = new Set<string>()
  if (outcomeSourceIds.length > 0) {
    let approvedQuery = supabase
      .from('recommendation_outcomes')
      .select('source_id')
      .in('source_id', outcomeSourceIds)
      .eq('review_status', 'approved')
    if (params.adAccountDbId) approvedQuery = approvedQuery.eq('ad_account_id', params.adAccountDbId)
    const { data: approved } = await approvedQuery
    for (const row of approved ?? []) {
      if (typeof row.source_id === 'string') approvedOutcomeSourceIds.add(row.source_id)
    }
  }

  const reviewedData = filterReviewedOutcomeMemories(data, approvedOutcomeSourceIds)
  if (reviewedData.length === 0) return []

  const ids = reviewedData.map((row: { id: string }) => row.id)

  // Fire-and-forget: update access tracking
  void supabase
    .from('agent_memory')
    .update({ last_accessed_at: new Date().toISOString() })
    .in('id', ids)
    .then(() => { /* fire-and-forget */ })

  return reviewedData.map(
    (row: {
      id: string
      memory_type: string
      context: string
      content: string
      tags: string[]
      importance: number
      created_at: string
    }) => ({
      id: row.id,
      type: row.memory_type,
      context: row.context,
      content: row.content,
      tags: row.tags,
      importance: row.importance,
      created_at: row.created_at,
    })
  )
}

export function filterReviewedOutcomeMemories<
  T extends { memory_type?: string | null; source_type?: string | null; source_id?: string | null },
>(rows: T[], approvedOutcomeSourceIds: ReadonlySet<string>): T[] {
  return rows.filter((row) => (
    (row.memory_type !== 'outcome' && row.source_type !== 'recommendation_outcome')
    || (typeof row.source_id === 'string' && approvedOutcomeSourceIds.has(row.source_id))
  ))
}

export async function storeTestOutcome(
  testId: string,
  result: 'winner' | 'loser',
  summary: string
): Promise<void> {
  const supabase = getAdminClient()

  const { data: test, error } = await supabase
    .from('tests')
    .select('ad_account_id, test_name, audience_type')
    .eq('id', testId)
    .single()

  if (error || !test) {
    console.error('[agent-memory] storeTestOutcome: failed to fetch test', error?.message)
    return
  }

  await storeMemory({
    adAccountDbId: test.ad_account_id,
    type: 'outcome',
    context: `Test ${test.test_name} (${test.audience_type ?? 'unknown'})`,
    content: summary,
    tags: ['test', result, test.audience_type ?? 'unknown'],
    importance: 4,
    source_type: 'test_result',
    source_id: testId,
  })
}

export async function storeRejection(approvalId: string, reason: string | null): Promise<void> {
  const supabase = getAdminClient()

  const { data: approval, error } = await supabase
    .from('pending_approvals')
    .select('id, trigger_summary, trigger_data, ad_account_id')
    .eq('id', approvalId)
    .single()

  if (error || !approval) {
    console.error('[agent-memory] storeRejection: failed to fetch approval', error?.message)
    return
  }

  await storeMemory({
    adAccountDbId: approval.ad_account_id,
    type: 'rejection',
    context: approval.trigger_summary ?? 'Unknown trigger',
    content: reason ?? 'Dismissed without reason',
    tags: ['rejected'],
    importance: 3,
    source_type: 'user_rejection',
    source_id: approvalId,
  })
}
