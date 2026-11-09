import { storeMemory, searchMemory } from '@/lib/memory/agent-memory'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export async function storeAgentMemory(args: {
  type: 'recommendation' | 'outcome' | 'rejection' | 'preference' | 'pattern'
  context: string
  content: string
  tags: string[]
  importance: 1 | 2 | 3 | 4 | 5
}): Promise<object> {
  if (!args.type || !args.context || !args.content) {
    return { error: 'type, context, and content are required' }
  }
  if (typeof args.importance !== 'number' || args.importance < 1 || args.importance > 5) {
    return { error: 'importance must be 1–5' }
  }

  const activeAccount = await resolveOnlyActiveAccount(getAdminClient())
  if (!activeAccount.ok) return {
    error: `Memory storage is unavailable because active account ownership is ${activeAccount.reason}.`,
    error_code: activeAccountErrorCode(activeAccount.reason),
  }

  const id = await storeMemory({
    adAccountDbId: activeAccount.account.id,
    type: args.type,
    context: args.context,
    content: args.content,
    tags: args.tags ?? [],
    importance: args.importance,
    source_type: 'manual',
  })

  return id
    ? { success: true, memory_id: id, message: `Memory stored with importance ${args.importance}.` }
    : { error: 'Failed to store memory' }
}

export async function searchAgentMemory(args: {
  query: string
  tags?: string[]
  limit?: number
}): Promise<object> {
  if (!args.query) {
    return { error: 'query is required' }
  }

  const activeAccount = await resolveOnlyActiveAccount(getAdminClient())
  if (!activeAccount.ok) return {
    error: `Memory search is unavailable because active account ownership is ${activeAccount.reason}.`,
    error_code: activeAccountErrorCode(activeAccount.reason),
    memories: [],
    count: 0,
  }

  const results = await searchMemory({
    adAccountDbId: activeAccount.account.id,
    query: args.query,
    tags: args.tags,
    limit: args.limit ?? 10,
  })

  return {
    count: results.length,
    memories: results,
    note: results.length === 0
      ? 'No memories found. Start building memory by storing test outcomes and rejected angles.'
      : `Found ${results.length} relevant memories, sorted by importance.`,
  }
}
