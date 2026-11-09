import 'server-only'
import { resolveOnlyActiveAccount, activeAccountErrorCode, type ActiveAccountErrorCode } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import type { SaveCopyRequest } from './copy-brief'
import { verifiedFacts } from './copy-context'
import { extractHook } from './copy-performance'
import { COPY_GOALS, AUDIENCE_TEMPERATURES, type CopyAngle, type CopyGoal, type AudienceTemperature } from './copy-rules'
import {
  scoreCopy as scorePure, scoreCopySet, type CopyScore, type CopySetScore, type CopyVariantInput,
} from './copy-scorer'

// The Copy studio's server functions: the entry points the console routes use today and the chat will
// use later. Scoring needs no AI: it reads the business profile's verified facts and runs the
// deterministic rules. The copy bank is the existing `copy_variations` table: a saved variant is one
// row per field (hook, primary_text, headline, description, cta), written in one insert so the rows
// share created_at, which is how they are read back together.

export { generateCopy, type GenerateCopyResult, type GeneratedCopyVariant } from './copy-generator'

/** Bank rows written by the Copy studio; `:sample` marks the demo dataset's hand-written examples. */
export const COPY_STUDIO_MODEL = 'copy_studio'
export const COPY_STUDIO_SAMPLE_MODEL = 'copy_studio:sample'
const BANK_FIELDS = ['hook', 'primary_text', 'headline', 'description', 'cta'] as const
const BANK_ROW_LIMIT = 200
const EXISTING_AD_LIMIT = 60

/** Score pasted copy or a variant against this business's verified facts. */
export function scoreCopy(input: string | CopyVariantInput, options: { goal?: CopyGoal } = {}): CopyScore {
  return scorePure(input, { facts: verifiedFacts(), goal: options.goal })
}

/** Score several variants together, so near-duplicates and repeated angles are flagged. */
export function scoreCopyVariants(variants: readonly CopyVariantInput[], options: { goal?: CopyGoal } = {}): CopySetScore {
  return scoreCopySet(variants, { facts: verifiedFacts(), goal: options.goal })
}

export interface SavedCopyVariant {
  key: string
  created_at: string
  angle: string | null
  goal: CopyGoal | null
  temperature: AudienceTemperature | null
  sample: boolean
  hook: string | null
  primary_text: string | null
  headline: string | null
  description: string | null
  cta: string | null
  score: CopyScore
}

export interface ScoredExistingAd {
  creative_id: string
  name: string | null
  hook: string | null
  primary_text: string | null
  headline: string | null
  description: string | null
  cta: string | null
  score: CopyScore
}

export type CopyStudioData =
  | { status: 'ok'; bank: SavedCopyVariant[]; existingAds: ScoredExistingAd[]; bankReadHealth: 'healthy' | 'unavailable'; adsReadHealth: 'healthy' | 'unavailable' }
  | { status: 'account_unavailable'; code: ActiveAccountErrorCode }

interface BankRow {
  copy_type: string
  copy_text: string
  angle: string | null
  performance_notes: string | null
  model_used: string | null
  created_at: string
}

export function bankNotes(request: Pick<SaveCopyRequest, 'goal' | 'temperature'>, score: number): string {
  return `Saved from Copy studio. Audience: ${request.temperature}. Goal: ${request.goal}. Score at save: ${score}/100.`
}

const noteValue = <T extends string>(notes: string | null, label: string, allowed: readonly T[]): T | null => {
  const value = notes?.match(new RegExp(`${label}: ([a-z_]+)`))?.[1]
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/** PURE: group bank rows saved together (same created_at and angle) back into variants and re-score them. */
export function groupBankRows(rows: readonly BankRow[], score: (v: CopyVariantInput, goal: CopyGoal | null) => CopyScore): SavedCopyVariant[] {
  const groups = new Map<string, BankRow[]>()
  for (const row of rows) {
    const key = `${row.created_at}|${row.angle ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].map(([key, group]) => {
    const pick = (type: string) => group.find((r) => r.copy_type === type)?.copy_text ?? null
    const notes = group[0].performance_notes
    const goal = noteValue(notes, 'Goal', COPY_GOALS)
    const fields = { hook: pick('hook'), primary_text: pick('primary_text'), headline: pick('headline'), description: pick('description'), cta: pick('cta') }
    return {
      key, created_at: group[0].created_at, angle: group[0].angle, goal, temperature: noteValue(notes, 'Audience', AUDIENCE_TEMPERATURES),
      sample: group.some((r) => r.model_used === COPY_STUDIO_SAMPLE_MODEL), ...fields,
      score: score({ ...fields, angle: group[0].angle }, goal),
    }
  })
}

/** The saved Copy studio variants of one account, re-scored; null when the read failed. */
export async function readBank(db: ReturnType<typeof getAdminClient>, accountId: string): Promise<SavedCopyVariant[] | null> {
  const { data, error } = await db
    .from('copy_variations')
    .select('copy_type, copy_text, angle, performance_notes, model_used, created_at')
    .eq('ad_account_id', accountId)
    .in('model_used', [COPY_STUDIO_MODEL, COPY_STUDIO_SAMPLE_MODEL])
    .order('created_at', { ascending: false })
    .limit(BANK_ROW_LIMIT)
  if (error) return null
  return groupBankRows((data ?? []) as BankRow[], (variant, goal) => scoreCopy(variant, { goal: goal ?? undefined }))
}

async function readExistingAds(db: ReturnType<typeof getAdminClient>, accountId: string): Promise<ScoredExistingAd[] | null> {
  const { data, error } = await db
    .from('creatives')
    .select('creative_id, creative_name, body, title, description, call_to_action_type')
    .eq('ad_account_id', accountId)
    .not('body', 'is', null)
    .order('last_synced_at', { ascending: false })
    .limit(EXISTING_AD_LIMIT)
  if (error) return null
  const ads = ((data ?? []) as Array<Record<string, string | null>>).map((row) => ({
    creative_id: String(row.creative_id), name: row.creative_name,
    hook: extractHook(row.body), primary_text: row.body, headline: row.title, description: row.description, cta: row.call_to_action_type,
  }))
  const scored = scoreCopyVariants(ads)
  return ads.map((ad, i) => ({ ...ad, score: scored.variants[i] })).sort((a, b) => b.score.score - a.score.score)
}

/** Everything the Copy studio page shows, scoped to the one active ad account. */
export async function loadCopyStudio(): Promise<CopyStudioData> {
  const db = getAdminClient()
  const account = await resolveOnlyActiveAccount(db)
  if (!account.ok) return { status: 'account_unavailable', code: activeAccountErrorCode(account.reason) }
  const [bank, ads] = await Promise.all([readBank(db, account.account.id), readExistingAds(db, account.account.id)])
  return {
    status: 'ok', bank: bank ?? [], existingAds: ads ?? [],
    bankReadHealth: bank ? 'healthy' : 'unavailable', adsReadHealth: ads ? 'healthy' : 'unavailable',
  }
}

export type SaveCopyResult =
  | { status: 'saved'; rows: number; score: CopyScore }
  | { status: 'blocked'; score: CopyScore }
  | { status: 'account_unavailable'; code: ActiveAccountErrorCode; reason: 'not_found' | 'ambiguous' | 'unavailable' }
  | { status: 'failed' }

/**
 * Save a variant to the bank. The score is recomputed here (a client-sent score is never trusted) and a
 * variant that is not publishable (unverified claim, policy risk, hard limit) is refused.
 */
export async function saveCopyVariant(request: SaveCopyRequest): Promise<SaveCopyResult> {
  const score = scoreCopy(request.variant, { goal: request.goal })
  if (!score.publishable) return { status: 'blocked', score }
  const db = getAdminClient()
  const account = await resolveOnlyActiveAccount(db)
  if (!account.ok) return { status: 'account_unavailable', code: activeAccountErrorCode(account.reason), reason: account.reason }
  const angle: CopyAngle = request.variant.angle
  const notes = bankNotes(request, score.score)
  const rows = BANK_FIELDS.flatMap((field) => {
    const text = request.variant[field]?.trim()
    return text ? [{
      ad_account_id: account.account.id, copy_type: field, audience_type: 'unknown', angle, copy_text: text,
      char_count: text.length, is_approved: false, is_used: false, performance_notes: notes, model_used: COPY_STUDIO_MODEL,
    }] : []
  })
  const { error } = await db.from('copy_variations').insert(rows)
  if (error) {
    console.error('[CopyStudio] Saving to the copy bank failed', error.code ?? 'unknown')
    return { status: 'failed' }
  }
  return { status: 'saved', rows: rows.length, score }
}
