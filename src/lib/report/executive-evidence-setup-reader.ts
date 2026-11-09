import type { SupabaseClient } from '@supabase/supabase-js'
import { projectMetaSetupEvidence } from '@/lib/report/setup-evidence'
import type {
  MetaSetupEvidenceProjection,
  SetupAdsetRow,
  SetupCreativeRow,
} from '@/lib/report/setup-evidence-types'
import {
  quarantineFailedSetupSources,
  validateSetupGeneration,
} from './executive-evidence-setup-health'
import {
  projectLatestSetupMaterialChange,
  type LatestSetupMaterialChangeV1,
  type SetupMaterialChangeV1,
} from '@/lib/setup-history'
import type { ExecutiveEvidenceBaseRequestV1, ExecutiveEvidenceSourceReadV1 } from './executive-evidence.types'
import {
  readLatestProjectionGenerationV1,
  readValidatedGenerationSetupRowsV1,
} from './executive-evidence-setup-snapshots'

const MAX_SETUP_PLANS = 50

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function booleanTrue(value: unknown): boolean {
  return value === true
}

type RolePlanRow = Record<string, unknown>
type ComparisonRoleBinding = Pick<SetupAdsetRow, 'comparison_role' | 'comparison_role_source'>

/**
 * Applies only the newest explicit comparison-role declaration. Ad-set names are never authority.
 * An invalid newer declaration fails closed instead of reviving an older intent silently.
 */
export function applyApprovedComparisonRoles<T extends Record<string, unknown>>(
  adsets: T[],
  planRows: RolePlanRow[],
  asOf: string,
): Array<T & ComparisonRoleBinding> {
  const unavailable = () => adsets.map((row) => ({
    ...row,
    comparison_role: null,
    comparison_role_source: null,
  }))
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(asOfMs)) return unavailable()

  const rolePlan = [...planRows]
    .sort((a, b) => String(b.approved_at ?? '').localeCompare(String(a.approved_at ?? '')))
    .find((row) => Array.isArray(objectOrNull(row.plan)?.comparison_roles))
  if (!rolePlan) return unavailable()

  const source = text(rolePlan.source_kind)
  const approvedBy = text(rolePlan.approved_by)
  const approvedAt = text(rolePlan.approved_at)
  const approvedMs = approvedAt ? Date.parse(approvedAt) : Number.NaN
  const declarations = objectOrNull(rolePlan.plan)?.comparison_roles
  if (
    (source !== 'owner_declared' && source !== 'campaign_plan')
    || !approvedBy
    || !Number.isFinite(approvedMs)
    || approvedMs > asOfMs
    || !Array.isArray(declarations)
    || declarations.length !== 2
  ) return unavailable()

  const parsed = declarations.map((entry) => {
    const row = objectOrNull(entry)
    return {
      id: text(row?.meta_adset_id),
      role: text(row?.role),
    }
  })
  const ids = parsed.map((row) => row.id)
  const roles = parsed.map((row) => row.role)
  const currentIds = new Set(adsets.map((row) => text(row.adset_id)).filter(Boolean))
  if (
    ids.some((id) => !id || !currentIds.has(id))
    || new Set(ids).size !== 2
    || roles.filter((role) => role === 'cold').length !== 1
    || roles.filter((role) => role === 'warm').length !== 1
  ) return unavailable()

  const byId = new Map(parsed.map((row) => [row.id, row.role as 'cold' | 'warm']))
  return adsets.map((row) => {
    const role = byId.get(text(row.adset_id)) ?? null
    return {
      ...row,
      comparison_role: role,
      comparison_role_source: role ? source : null,
    }
  })
}

export function projectAdSetupDecisionMaterialChangeForExecutive(
  row: Record<string, unknown>,
): LatestSetupMaterialChangeV1 {
  const occurredAt = text(row.action_taken_date) ?? text(row.decision_date) ?? text(row.created_at)
  const reason = text(row.reason)
  const id = text(row.id)
  const userDecision = text(row.user_decision)
  const finalValue = text(row.final_value)
  const actualLaunchedValue = text(row.actual_launched_value)
  const executed =
    booleanTrue(row.action_taken) &&
    Boolean(text(row.action_taken_date)) &&
    (userDecision === 'acted_on' || userDecision === 'accepted') &&
    Boolean(finalValue) &&
    Boolean(actualLaunchedValue)
  if (!occurredAt || !reason || !id || !executed) {
    return {
      status: 'unknown',
      occurredAt,
      reasonCode: 'setup_change_reason_unknown',
    }
  }
  return {
    status: 'known',
    governanceBasis: 'confirmed_executed_decision',
    materialChangeId: id,
    materialChangeIds: [id],
    occurredAt,
    reason,
    source: 'ad_setup_decisions',
    settingCategories: [text(row.setting_category) ?? 'unknown'],
    affectedMetaIds: text(row.entity_key) ? [text(row.entity_key)!] : [],
  }
}

async function readLatestMaterialChange(
  db: SupabaseClient,
  request: ExecutiveEvidenceBaseRequestV1,
): Promise<LatestSetupMaterialChangeV1> {
  const material = await db
    .from('setup_material_changes')
    .select('id, to_generation_id, created_at')
    .eq('ad_account_id', request.accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
  if (material.error) throw new Error(`setup_material_changes read failed: ${material.error.message}`)
  const latest = material.data?.[0] as Record<string, unknown> | undefined
  if (latest) {
    const generationId = text(latest.to_generation_id)
    if (!generationId) {
      return {
        status: 'unknown',
        occurredAt: text(latest.created_at),
        reasonCode: 'setup_change_identity_unknown',
      }
    }
    const batch = await db
      .from('setup_material_changes')
      .select(
        'id, ad_account_id, from_generation_id, to_generation_id, entity_level, meta_entity_id, change_type, field_path, before_value, after_value, reason_status, approved_plan_id, reason, created_at',
      )
      .eq('ad_account_id', request.accountId)
      .eq('to_generation_id', generationId)
      .order('id', { ascending: true })
    if (batch.error) throw new Error(`setup material-change batch read failed: ${batch.error.message}`)
    if (!Array.isArray(batch.data)) throw new Error('setup material-change batch read returned a non-array result')
    return projectLatestSetupMaterialChange({
      changes: batch.data as Array<SetupMaterialChangeV1 & { created_at?: string | null }>,
      through: request.asOf,
    })
  }

  const decision = await db
    .from('ad_setup_decisions')
    .select(
      'id, action_taken, action_taken_date, user_decision, decision_date, created_at, reason, setting_category, entity_key, final_value, actual_launched_value',
    )
    .eq('ad_account_id', request.accountId)
    .eq('action_taken', true)
    .order('action_taken_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
  if (decision.error) throw new Error(`ad_setup_decisions read failed: ${decision.error.message}`)
  const acted = decision.data?.[0] as Record<string, unknown> | undefined
  if (!acted) {
    return {
      status: 'unknown',
      occurredAt: null,
      reasonCode: 'setup_change_reason_unknown',
    }
  }
  return projectAdSetupDecisionMaterialChangeForExecutive(acted)
}

async function readComparisonRolePlans(
  db: SupabaseClient,
  request: ExecutiveEvidenceBaseRequestV1,
): Promise<RolePlanRow[]> {
  const result = await db
    .from('setup_change_plans')
    .select('id, source_kind, approved_at, approved_by, plan')
    .eq('ad_account_id', request.accountId)
    .lte('approved_at', request.asOf)
    .order('approved_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MAX_SETUP_PLANS)
  if (result.error) throw new Error(`setup_change_plans read failed: ${result.error.message}`)
  if (!Array.isArray(result.data)) throw new Error('setup_change_plans read returned a non-array result')
  return result.data as RolePlanRow[]
}

export async function readExecutiveSetupEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceBaseRequestV1,
  options: { currentRunSetupGenerationId?: string | null } = {},
): Promise<ExecutiveEvidenceSourceReadV1<MetaSetupEvidenceProjection>> {
  const account = await db
    .from('ad_accounts')
    .select('account_id')
    .eq('id', request.accountId)
    .eq('is_active', true)
    .maybeSingle()
  if (account.error) throw new Error(`ad_accounts read failed: ${account.error.message}`)
  const metaAccountId = text(account.data?.account_id)
  if (!metaAccountId) throw new Error('active Meta account identity is unavailable')
  const [latestMaterialChange, rolePlans, latestSetupGeneration] = await Promise.all([
    readLatestMaterialChange(db, request),
    readComparisonRolePlans(db, request),
    readLatestProjectionGenerationV1(db, request.accountId),
  ])
  const setupGeneration = validateSetupGeneration(
    latestSetupGeneration,
    request.asOf,
    options.currentRunSetupGenerationId,
  )
  if (setupGeneration.blocksAll) {
    return {
      availability: 'unavailable',
      head: setupGeneration.head,
      blockerCodes: setupGeneration.blockerCodes,
      data: null,
    }
  }
  if (!latestSetupGeneration) throw new Error('validated meta setup generation disappeared')
  const generationRows = await readValidatedGenerationSetupRowsV1(
    db,
    request.accountId,
    latestSetupGeneration,
  )
  const currentSources = quarantineFailedSetupSources(
    generationRows.audience,
    generationRows.creatives as unknown as Record<string, unknown>[],
    setupGeneration.blockerCodes,
  )
  const adsets = applyApprovedComparisonRoles(
    generationRows.adsets,
    rolePlans,
    request.asOf,
  ) as unknown as SetupAdsetRow[]
  const projection = projectMetaSetupEvidence({
    as_of: request.asOf,
    ad_account_db_id: request.accountId,
    meta_account_id: metaAccountId,
    audience_inventory: currentSources.audience.audience_inventory,
    audiences_by_id: currentSources.audience.audiences_by_id,
    campaigns: generationRows.campaigns,
    adsets,
    ads: generationRows.ads,
    creatives: currentSources.creativeRows as unknown as SetupCreativeRow[],
    latest_material_change: latestMaterialChange,
  })
  const blockerCodes = [...new Set([...projection.blocker_codes, ...setupGeneration.blockerCodes])]
  const hardenedProjection: MetaSetupEvidenceProjection = blockerCodes.length === 0
    ? projection
    : {
        ...projection,
        status: 'blocked',
        complete: false,
        blocker_codes: blockerCodes,
        cold_warm_comparison: {
          ...projection.cold_warm_comparison,
          status: 'blocked',
          blocker_codes: [...new Set([
            ...projection.cold_warm_comparison.blocker_codes,
            ...setupGeneration.blockerCodes,
          ])],
        },
      }
  return {
    availability: hardenedProjection.complete ? 'available' : 'partial',
    head: setupGeneration.head,
    blockerCodes: [...hardenedProjection.blocker_codes],
    data: hardenedProjection,
  }
}
